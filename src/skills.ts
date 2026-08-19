import type { Database } from "bun:sqlite";
import { toolUseTag } from "./jsonl.ts";
import { archiveSpan, escapeLike } from "./query.ts";

// How often each named command was invoked, counted out of the archive.
//
// This lives in cerebro because the markers do. A skill call leaves no field of its
// own in the JSONL: it is text inside a turn, and one of the two forms is cerebro's
// own rendering (see SKILL_TAG). An outside consumer counting these strings is
// coupled to this repo's flattener, and when the flattener changes it gets zero hits
// and reports every skill as unused, confidently and silently. So the counting and
// the knowledge behind it stay here.
//
// "Named command", not "skill", is the honest word for what comes out: the slash
// marker is Claude Code's expansion of any `/name`, so its own built-ins (/clear,
// /model) are in the list. Filtering them would be a denylist to maintain every time
// Claude Code ships a command, so the caller filters against whatever list it owns.
// Merging renamed skills and explaining why a number is low stay with the caller too.

// Claude Code's expansion of a typed `/name`, embedded in the user turn.
const SLASH_OPEN = "<command-name>";
const SLASH_CLOSE = "</command-name>";

// The model's Skill tool call, as flattenContent renders it. Derived from the
// flattener so the two cannot drift apart.
const SKILL_TAG = toolUseTag("Skill");

// Deliberately absent: a third marker. `Launching skill: <name>` is the tool_result
// side of a SKILL_TAG call, not an independent signal, and counting it would double
// every model-side call. It is also on the user side, so the role filter below drops
// it anyway.

export interface SkillUsageRow {
  name: string;
  // Calls made by typing `/name`.
  slash: number;
  // Calls the model made through the Skill tool.
  model: number;
  total: number;
  // How many of `total` came from a subagent turn. A subagent that calls a skill is
  // using it, so those count; they get their own number because they answer a
  // different question than "how often did I reach for this myself".
  sidechain: number;
  lastTs: string | null;
}

export interface SkillUsage {
  rows: SkillUsageRow[];
  // Names seen before `limit` trimmed the list.
  distinct: number;
  // The window the counts cover: `since` (or the archive's first message) to its
  // last. A consumer needs it to tell "never called" from "called before the archive
  // begins".
  from: string | null;
  to: string | null;
}

export interface SkillUsageOpts {
  // ISO date cutoff, lexical compare on ts like search --since.
  since?: string;
  limit?: number;
}

// A marker only counts when it opens a line, which is most of what separates a call
// from a transcript quoting one. The model tag is rendered by flattenContent, which
// joins blocks with a newline, so a real one always opens a line. On the slash side
// the producer is Claude Code, and every one of the ~1100 expansions in this archive
// opens a line, while the mid-line ones are all cerebro's own `show` / `recent` output
// quoted back into a tool_result, where a whole turn is collapsed onto one line.
//
// What it does not catch: a marker deliberately quoted on a line of its own, in a
// fenced code block or a doc about this very command, is indistinguishable from a
// call. The shape filter below bounds the damage but cannot see intent, so treat a
// name that only ever appears once as what it is, one occurrence.
const opensLine = (text: string, at: number): boolean => at === 0 || text[at - 1] === "\n";

// What a name may look like. Not a denylist of commands (that would be a table to
// maintain), a bound on the shape: the text between two markers is foreign input, and
// without this an opening tag whose nearest closing tag is far away turns an arbitrary
// multi-line slice of someone's transcript into a "skill name", printed raw into a
// listing an agent reads. Every one of the 78 names in this archive passes, the
// plugin-qualified `code-review:code-review` included.
const NAME_SHAPE = /^[A-Za-z0-9][\w.:/-]{0,63}$/;

// Every `/name` expansion in one turn. Occurrences, not messages: a turn can carry
// two markers, so counting rows would be a lower bound on counting calls.
const eachSlashCall = (text: string, add: (name: string) => void): void => {
  let at = text.indexOf(SLASH_OPEN);
  while (at !== -1) {
    const from = at + SLASH_OPEN.length;
    const end = text.indexOf(SLASH_CLOSE, from);
    if (end === -1) return;
    // An unclosed tag must not swallow the next one: without this resync the closing
    // tag found belongs to a later marker, and that marker is both lost and turned
    // into a multi-line name.
    const nextOpen = text.indexOf(SLASH_OPEN, from);
    if (nextOpen !== -1 && nextOpen < end) {
      at = nextOpen;
      continue;
    }
    if (opensLine(text, at)) {
      const name = text.slice(from, end).trim().replace(/^\//, "");
      if (NAME_SHAPE.test(name)) add(name);
    }
    at = text.indexOf(SLASH_OPEN, end + SLASH_CLOSE.length);
  }
};

// Every Skill tool call in one turn. The payload is matched, not parsed: a call with
// arguments renders as {"skill":"x","args":"..."}, a long argument list is truncated
// mid-JSON by the tool-text cap, and JSON.parse would then drop exactly the calls that
// carry arguments. Matching the field also survives a reordered key. It survives
// either of those, not both: an args-first payload truncated before the skill field is
// lost, which no row in this archive is.
const eachModelCall = (text: string, add: (name: string) => void): void => {
  let at = text.indexOf(SKILL_TAG);
  while (at !== -1) {
    const from = at + SKILL_TAG.length;
    if (opensLine(text, at)) {
      const eol = text.indexOf("\n", from);
      const payload = eol === -1 ? text.slice(from) : text.slice(from, eol);
      const name = payload.match(/"skill"\s*:\s*"([^"]+)"/)?.[1];
      if (name !== undefined && NAME_SHAPE.test(name)) add(name);
    }
    at = text.indexOf(SKILL_TAG, from);
  }
};

interface MarkedRow {
  role: string;
  text: string | null;
  ts: string | null;
  is_sidechain: number;
}

export const skillUsage = (db: Database, opts: SkillUsageOpts = {}): SkillUsage => {
  // The rest of not counting our own measurements. The role decides which marker can
  // appear at all (an assistant writing about `/name` is prose, a Skill tool call in a
  // user turn is a quote), and a user turn that opens with a flattened tool tag is
  // machine output rather than something typed, which is where cerebro's own listings
  // come back in through a Bash result. That predicate is the one `search --prose`
  // uses. The LIKE patterns are pre-filters for the scan below, escaped because
  // SKILL_TAG contains a `_`.
  const marked = db
    .query(
      `SELECT role, text, ts, is_sidechain FROM messages
       WHERE ($since IS NULL OR ts >= $since)
         AND ((role = 'user'      AND text LIKE $slashLike ESCAPE '\\'
                                  AND text NOT LIKE '[tool\\_%' ESCAPE '\\')
           OR (role = 'assistant' AND text LIKE $tagLike   ESCAPE '\\'))`,
    )
    .all({
      $since: opts.since ?? null,
      $slashLike: `%${escapeLike(SLASH_OPEN)}%`,
      $tagLike: `%${escapeLike(SKILL_TAG)}%`,
    }) as MarkedRow[];

  const counts = new Map<string, SkillUsageRow>();
  const bump = (name: string, kind: "slash" | "model", row: MarkedRow): void => {
    const entry = counts.get(name) ?? {
      name,
      slash: 0,
      model: 0,
      total: 0,
      sidechain: 0,
      lastTs: null,
    };
    entry[kind]++;
    entry.total++;
    if (row.is_sidechain === 1) entry.sidechain++;
    if (row.ts !== null && (entry.lastTs === null || row.ts > entry.lastTs)) entry.lastTs = row.ts;
    counts.set(name, entry);
  };

  for (const row of marked) {
    if (row.text === null) continue;
    if (row.role === "user") eachSlashCall(row.text, (name) => bump(name, "slash", row));
    else eachModelCall(row.text, (name) => bump(name, "model", row));
  }

  const ordered = [...counts.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
  const span = archiveSpan(db);
  return {
    rows: opts.limit === undefined ? ordered : ordered.slice(0, opts.limit),
    distinct: ordered.length,
    from: opts.since ?? span.first,
    to: span.last,
  };
};
