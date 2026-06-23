import type { Database } from "bun:sqlite";
import { searchSummaryRoots, threadMeta, toMatchQuery } from "./query.ts";
import { rootOf, threadLastTs } from "./thread.ts";

// The summarization contract lives here, in the CLI, not in the hook that invokes
// the model. cerebro owns the prompt and the storage format together (they are two
// halves of one contract: `digest write` stores exactly what this prompt asks for),
// and owns the version so stale summaries can be re-generated when the prompt
// improves. cerebro never calls an LLM itself; a hook or skill pipes the transcript
// through `claude -p "$(cerebro digest prompt)"` and writes the result back.
//
// Bump DIGEST_PROMPT_VERSION whenever the prompt changes in a way that should
// invalidate existing summaries (staleThreads then re-surfaces them).
export const DIGEST_PROMPT_VERSION = 1;

// The opening sentence of DIGEST_PROMPT, factored out so the indexer can recognize
// cerebro's own headless `claude -p` summarization runs. Those runs are recorded by
// Claude Code as ordinary sessions under ~/.claude/projects, and their first user
// message is this prompt verbatim; the indexer matches on this prefix to refuse to
// index them (see isDigestRunTranscript in indexer.ts). Keep it as the literal start
// of DIGEST_PROMPT: if you reword the opening, historical digest transcripts on disk
// stop being detected on a `--full` re-read.
export const DIGEST_PROMPT_SIGNATURE =
  "You are summarizing a single Claude Code session for a personal, full-text-searchable archive.";

export const DIGEST_PROMPT = `${DIGEST_PROMPT_SIGNATURE} The summary is read later both by a human skimming past work and by an AI agent hunting for related sessions, so it must be dense, factual, and easy to match on concrete terms.

You will be given the full session transcript. Write a summary as follows.

First line: one sentence stating what the session was about and where it happened (name the repo, service, or project when identifiable).

Then a few tight sentences of plain prose covering what actually happened: what was explored, built, changed, fixed, decided, or discussed. Adapt to the session. Most sessions are routine work (grinding through tickets, small edits, quick lookups) with no significant decision, and that is fine. Do not manufacture importance. A routine session deserves one or two sentences; a substantial design or debugging session deserves a short paragraph. Never pad, never invent.

Mention decisions, rationale, trade-offs, or unfinished/open threads only when they genuinely occurred. If nothing was decided and nothing was left open, leave both out.

Preserve concrete, searchable terms verbatim: file paths, package and service names, function and symbol names, ticket ids (e.g. VKT-1234), URLs, commands, and key technical or domain concepts. These are how the session gets found later.

Last line: a single line beginning "Keywords:" with a compact comma-separated list of the concrete things the session touched (files, paths, packages, services, tickets, tools, concepts). Keep identifiers verbatim. For a pure discussion with nothing concrete, list the main topics instead.

Write in the session's dominant language (Swedish or English). Be terse. Output only the summary itself: no preamble, no heading, no sign-off, no markdown formatting.`;

// Upper bound, in characters, for the transcript handed to a single `claude -p`
// summarization call. cerebro has no tokenizer (it takes no deps), so this is a
// character proxy: at a conservative ~3 chars/token for dense transcripts it
// keeps the rendered input under ~850k tokens, which fits a 1M-context model with
// room left for the prompt and the summary. Threads below this render verbatim
// (byte-identical to `show --full`); only the rare oversized thread is condensed.
// pickDigestModel picks the model by measured size (small -> Haiku's 200k, large
// -> a 1M-context model), so this cap is the final backstop ensuring even a 1M
// model never overflows, not the primary size control.
export const DIGEST_INPUT_MAX_CHARS = 2_700_000;

export interface DigestModelConfig {
  small: string;
  large: string;
  thresholdChars: number;
}

// The size -> model tiering config, read from the same env vars the summarize hook
// has always used (so any override keeps working) with the same defaults. Empty or
// unset falls back to the default, matching bash `${VAR:-default}`.
export const digestModelConfig = (): DigestModelConfig => {
  const threshold = process.env.CEREBRO_DIGEST_HAIKU_MAX_CHARS;
  const parsed = threshold ? Number(threshold) : 540_000;
  return {
    small: process.env.CEREBRO_DIGEST_MODEL || "claude-haiku-4-5",
    large: process.env.CEREBRO_DIGEST_MODEL_LARGE || "claude-sonnet-4-6[1m]",
    // A non-numeric override falls back rather than becoming NaN (which would
    // wedge every thread on the small model).
    thresholdChars: Number.isFinite(parsed) ? parsed : 540_000,
  };
};

// Pick the summarization model for a transcript of `byteCount` bytes (the size of
// the rendered `digest input`, measured the same way the hook did with `wc -c` --
// bytes, not characters, so multibyte threads tier correctly). Small threads (the
// common case) get the cheap small model; only an oversized thread escalates to the
// large 1M-context model. The threshold is a byte proxy because cerebro has no
// tokenizer. Single source of truth for the tiering the summarize hook used to
// inline in bash; `> threshold` matches its strict comparison (a thread at the
// threshold stays on the small model).
export const pickDigestModel = (
  byteCount: number,
  config: DigestModelConfig = digestModelConfig(),
): string => (byteCount > config.thresholdChars ? config.large : config.small);

interface RenderableMessage {
  role: string;
  ts: string | null;
  text: string;
  is_sidechain: number;
}

const renderHeader = (message: RenderableMessage): string => {
  const tag = message.is_sidechain ? " · subagent" : "";
  // ts is the raw stored UTC value; this rendering is model input, not a
  // human-facing display, so it is left unconverted.
  return `──── ${message.role}${tag} · ${message.ts ?? ""} ────\n`;
};

// Render a whole thread as the summarization input, bounded to `maxChars` so it
// fits a single model context. Below budget every message renders verbatim
// (identical to `show --full`). Above budget every message is kept, preserving
// the shape of the whole conversation, but each body is capped to a fair
// per-message share via a water-fill: short messages (user steers, tool calls)
// stay whole while the longest assistant essays are trimmed first. The largest
// per-body cap whose rendered total fits the budget is found by binary search.
export const buildDigestInput = (
  messages: RenderableMessage[],
  maxChars = DIGEST_INPUT_MAX_CHARS,
): string => {
  const headers = messages.map(renderHeader);
  const bodies = messages.map((message) => message.text);
  // Each block is header + body + a trailing blank-line separator ("\n" after the
  // body, then "\n" joined between blocks): two newlines of fixed overhead.
  const fixed = headers.reduce((sum, header) => sum + header.length + 2, 0);
  const total = fixed + bodies.reduce((sum, body) => sum + body.length, 0);

  const render = (cap: number | null): string =>
    messages
      .map((_message, i) => {
        const body = bodies[i]!;
        const capped =
          cap !== null && body.length > cap
            ? `${body.slice(0, cap)}\n[+${body.length - cap} chars truncated for digest]`
            : body;
        return `${headers[i]}${capped}\n`;
      })
      .join("\n");

  if (total <= maxChars) return render(null);

  // Largest body cap C with sum(min(len, C)) <= bodyBudget. The truncation marker
  // adds a little per trimmed body, but it is bounded and well inside the headroom
  // baked into maxChars, so the water-fill ignores it.
  const bodyBudget = Math.max(0, maxChars - fixed);
  let lo = 0;
  let hi = bodies.reduce((max, body) => Math.max(max, body.length), 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const used = bodies.reduce((sum, body) => sum + Math.min(body.length, mid), 0);
    if (used <= bodyBudget) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
};

export interface StaleThread {
  id: string;
  last_ts: string | null;
  first_ts: string | null;
  msgs: number;
  project_path: string | null;
  title: string | null;
  summary_version: number | null;
  summarized_at: string | null;
}

// Thread roots that need a (re)summary: never summarized, summarized before the
// thread's latest activity, or summarized by an older prompt version. Reads the
// shared `threads` rollup view (see db.ts), then left-joins summaries.
export const staleThreads = (db: Database, limit = 50): StaleThread[] =>
  db
    .query(
      `SELECT t.id, t.last_ts, t.first_ts, t.msgs, t.project_path, t.title,
              su.prompt_version AS summary_version, su.summarized_at AS summarized_at
       FROM threads t
       LEFT JOIN summaries su ON su.root_session_id = t.id
       WHERE su.root_session_id IS NULL
          OR su.source_last_ts IS NULL
          OR su.source_last_ts < t.last_ts
          OR su.prompt_version < ?
       ORDER BY t.last_ts DESC
       LIMIT ?`,
    )
    .all(DIGEST_PROMPT_VERSION, limit) as StaleThread[];

// Store a summary for the thread that owns `sessionId`. Upserts on the thread root,
// stamping the current prompt version and the thread's current last_ts (so later
// activity makes it stale). The FTS triggers keep summaries_fts in sync. Returns
// the root id the summary was attributed to.
export const writeSummary = (
  db: Database,
  sessionId: string,
  summary: string,
  model: string | null = null,
): string => {
  const root = rootOf(db, sessionId);
  const sourceLastTs = threadLastTs(db, root);

  db.query(
    `INSERT INTO summaries (root_session_id, summary, prompt_version, model, summarized_at, source_last_ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(root_session_id) DO UPDATE SET
       summary        = excluded.summary,
       prompt_version = excluded.prompt_version,
       model          = excluded.model,
       summarized_at  = excluded.summarized_at,
       source_last_ts = excluded.source_last_ts`,
  ).run(root, summary, DIGEST_PROMPT_VERSION, model, new Date().toISOString(), sourceLastTs);

  return root;
};

export interface StoredSummary {
  root_session_id: string;
  summary: string;
  prompt_version: number;
  model: string | null;
  summarized_at: string;
  source_last_ts: string | null;
}

export const getSummary = (db: Database, sessionId: string): StoredSummary | null =>
  db
    .query("SELECT * FROM summaries WHERE root_session_id = ?")
    .get(rootOf(db, sessionId)) as StoredSummary | null;

export interface SummaryHit {
  id: string;
  last_ts: string | null;
  project_path: string | null;
  title: string | null;
  snippet: string;
}

// Full-text search over the curated summaries (not the raw transcripts). The prose
// prompt is turned into an OR-of-tokens query like `relevant`, so a topical query
// surfaces the best-matching summaries without requiring every word to co-occur.
export const searchSummaries = (db: Database, query: string, limit = 10): SummaryHit[] => {
  const match = toMatchQuery(query);
  if (!match) return [];

  let rows: { root: string; snippet: string }[];
  try {
    rows = searchSummaryRoots(db, match, limit, 12);
  } catch {
    return [];
  }

  return rows.map((row) => {
    const meta = threadMeta(db, row.root);
    return {
      id: row.root,
      last_ts: meta?.last_ts ?? null,
      project_path: meta?.project_path ?? null,
      title: meta?.title ?? null,
      snippet: row.snippet,
    };
  });
};
