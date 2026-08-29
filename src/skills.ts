import type { Database } from "bun:sqlite";
import { escapeLike } from "./fts.ts";
import { toolUseTag } from "./jsonl.ts";
import { archiveSpan } from "./stats.ts";

// Design notes: docs/architecture.md ("Skills").

const SLASH_OPEN = "<command-name>";
const SLASH_CLOSE = "</command-name>";

// Derived from the flattener so the two cannot drift.
const SKILL_TAG = toolUseTag("Skill");

// Deliberately no third marker: "Launching skill: <name>" is the tool_result side
// of a SKILL_TAG call and would double-count it.

export interface SkillUsageRow {
  name: string;
  slash: number;
  model: number;
  total: number;
  sidechain: number;
  lastTs: string | null;
}

export interface SkillUsage {
  rows: SkillUsageRow[];
  distinct: number;
  // The counted window, to tell "never called" from "called before the archive
  // begins".
  from: string | null;
  to: string | null;
}

export interface SkillUsageOpts {
  since?: string;
  limit?: number;
}

// A marker only counts when it opens a line: a real call always does, while
// mid-line occurrences are cerebro's own listings quoted back through a
// tool_result.
const opensLine = (text: string, at: number): boolean => at === 0 || text[at - 1] === "\n";

// A bound on the shape, not a denylist: without it an unclosed tag turns an
// arbitrary multi-line slice of transcript into a "skill name".
const NAME_SHAPE = /^[A-Za-z0-9][\w.:/-]{0,63}$/;

const eachSlashCall = (text: string, add: (name: string) => void): void => {
  let at = text.indexOf(SLASH_OPEN);
  while (at !== -1) {
    const from = at + SLASH_OPEN.length;
    const end = text.indexOf(SLASH_CLOSE, from);
    if (end === -1) return;
    // Resync on an unclosed tag: otherwise the closing tag found belongs to a
    // later marker, which is both lost and turned into a multi-line name.
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

// Matched, not JSON.parsed: the tool-text cap truncates long argument lists
// mid-JSON, which would drop exactly the calls that carry arguments.
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
  // The role decides which marker can appear at all, and a user turn opening
  // with a flattened tool tag is machine output (our own listings coming back
  // through a Bash result). LIKE patterns are pre-filters, escaped because
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
