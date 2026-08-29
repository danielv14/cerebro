import type { Database } from "bun:sqlite";
import { escapeLike } from "./fts.ts";
import { toolUseTag } from "./jsonl.ts";
import { archiveSpan } from "./stats.ts";

// Skill-call counting. Why it lives in cerebro, and why the unit is "named
// command" rather than "skill": docs/architecture.md ("Skills").

// Claude Code's expansion of a typed `/name`, embedded in the user turn.
const SLASH_OPEN = "<command-name>";
const SLASH_CLOSE = "</command-name>";

// Derived from the flattener so the two cannot drift apart.
const SKILL_TAG = toolUseTag("Skill");

// Deliberately absent: a third marker. `Launching skill: <name>` is the
// tool_result side of a SKILL_TAG call and would double-count every model-side
// call.

export interface SkillUsageRow {
  name: string;
  // Calls made by typing `/name`.
  slash: number;
  // Calls the model made through the Skill tool.
  model: number;
  total: number;
  // How many of `total` came from a subagent turn.
  sidechain: number;
  lastTs: string | null;
}

export interface SkillUsage {
  rows: SkillUsageRow[];
  // Names seen before `limit` trimmed the list.
  distinct: number;
  // The window the counts cover, to tell "never called" from "called before the
  // archive begins".
  from: string | null;
  to: string | null;
}

export interface SkillUsageOpts {
  since?: string;
  limit?: number;
}

// A marker only counts when it opens a line: a real slash expansion always does,
// while mid-line occurrences are cerebro's own listings quoted back through a
// tool_result. What it cannot catch: a marker deliberately quoted on a line of its
// own (a fenced code block, a doc about this very command) is indistinguishable
// from a call.
const opensLine = (text: string, at: number): boolean => at === 0 || text[at - 1] === "\n";

// A bound on the shape, not a denylist: the text between two markers is foreign
// input, and without this an opening tag whose nearest closing tag is far away
// turns an arbitrary multi-line slice of a transcript into a "skill name".
const NAME_SHAPE = /^[A-Za-z0-9][\w.:/-]{0,63}$/;

// Occurrences, not messages: a turn can carry two markers.
const eachSlashCall = (text: string, add: (name: string) => void): void => {
  let at = text.indexOf(SLASH_OPEN);
  while (at !== -1) {
    const from = at + SLASH_OPEN.length;
    const end = text.indexOf(SLASH_CLOSE, from);
    if (end === -1) return;
    // An unclosed tag must not swallow the next one: without this resync the
    // closing tag found belongs to a later marker, which would be both lost and
    // turned into a multi-line name.
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

// The payload is matched, not parsed: the tool-text cap truncates a long argument
// list mid-JSON, and JSON.parse would then drop exactly the calls that carry
// arguments. An args-first payload truncated before the skill field is still lost,
// which no row in this archive is.
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
  // The role decides which marker can appear at all (an assistant writing about
  // `/name` is prose, a Skill tool call in a user turn is a quote), and a user turn
  // that opens with a flattened tool tag is machine output (cerebro's own listings
  // coming back through a Bash result). The LIKE patterns are pre-filters for the
  // scan below, escaped because SKILL_TAG contains a `_`.
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
