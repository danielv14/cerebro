import type { Database } from "bun:sqlite";
import { toolUseTag } from "./jsonl.ts";

// How often each skill was actually invoked, counted out of the archive.
//
// This lives in cerebro because the markers do. A skill call leaves no field of its
// own in the JSONL: it is text inside a turn, and one of the two forms is cerebro's
// own rendering (see SKILL_TAG). An outside consumer counting these strings is
// coupled to this repo's flattener, and when the flattener changes it gets zero hits
// and reports every skill as unused, confidently and silently. So the counting and
// the knowledge behind it stay here.
//
// What the command deliberately does not do: merge renamed skills, explain a low
// number, or filter out Claude Code's built-ins (/clear, /model). Those are
// judgements about one person's habits, and a denylist here would be a table to
// maintain every time Claude Code ships a command. It reports the names it saw.

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
  // Messages that carried at least one marker.
  scanned: number;
}

export interface SkillUsageOpts {
  // ISO date cutoff, lexical compare on ts like search --since.
  since?: string;
  limit?: number;
}

// Every `/name` expansion in one turn. Occurrences, not messages: a turn can carry
// two markers, so counting rows would be a lower bound on counting calls.
const eachSlashCall = (text: string, add: (name: string) => void): void => {
  let at = text.indexOf(SLASH_OPEN);
  while (at !== -1) {
    const from = at + SLASH_OPEN.length;
    const end = text.indexOf(SLASH_CLOSE, from);
    if (end === -1) return;
    const name = text.slice(from, end).trim().replace(/^\//, "");
    if (name) add(name);
    at = text.indexOf(SLASH_OPEN, end + SLASH_CLOSE.length);
  }
};

// Every Skill tool call in one turn. Two details carry the accuracy:
//
// The payload is matched, not parsed. A call with arguments renders as
// {"skill":"x","args":"..."}, a long argument list is truncated mid-JSON by the
// tool-text cap, and JSON.parse would then drop exactly the calls that carry
// arguments. Matching the field also survives a different key order, where a fixed
// `{"skill":"` prefix would not.
//
// The tag must open a line. flattenContent joins blocks with a newline, so a real
// tool_use rendering always starts one; a marker quoted mid-sentence is an assistant
// explaining the format, not a call. Without the anchor, writing about this very
// command adds skills named after its examples.
const eachModelCall = (text: string, add: (name: string) => void): void => {
  let at = text.indexOf(SKILL_TAG);
  while (at !== -1) {
    const from = at + SKILL_TAG.length;
    if (at === 0 || text[at - 1] === "\n") {
      const eol = text.indexOf("\n", from);
      const payload = eol === -1 ? text.slice(from) : text.slice(from, eol);
      const name = payload.match(/"skill"\s*:\s*"([^"]+)"/)?.[1];
      if (name) add(name);
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
  // The role in each branch is the load-bearing half. A transcript that *quotes* a
  // marker (a grep hit, a report printing these very numbers) lands in a
  // [tool_result] on the user side, and an assistant that mentions `/name` in prose
  // is the mirror case. Without the roles the archive counts its own measurements,
  // which is observed rather than hypothetical.
  const marked = db
    .query(
      `SELECT role, text, ts, is_sidechain FROM messages
       WHERE ($since IS NULL OR ts >= $since)
         AND ((role = 'user'      AND text LIKE $slashLike)
           OR (role = 'assistant' AND text LIKE $tagLike))`,
    )
    .all({
      $since: opts.since ?? null,
      $slashLike: `%${SLASH_OPEN}%`,
      $tagLike: `%${SKILL_TAG}%`,
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
  // Span from the sessions table for the same reason stats does it: messages.ts is
  // unindexed, and the session aggregates are recomputed from it on every touch.
  const span = db.query("SELECT MIN(first_ts) AS mn, MAX(last_ts) AS mx FROM sessions").get() as {
    mn: string | null;
    mx: string | null;
  };
  return {
    rows: opts.limit === undefined ? ordered : ordered.slice(0, opts.limit),
    distinct: ordered.length,
    from: opts.since ?? span.mn,
    to: span.mx,
    scanned: marked.length,
  };
};
