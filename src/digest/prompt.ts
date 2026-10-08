import { DIGEST_PROMPT_SIGNATURE } from "./signature.ts";

// Bump whenever the prompt changes in a way that should invalidate existing
// summaries.
export const DIGEST_PROMPT_VERSION = 1;

export const DIGEST_PROMPT = `${DIGEST_PROMPT_SIGNATURE} The summary is read later both by a human skimming past work and by an AI agent hunting for related sessions, so it must be dense, factual, and easy to match on concrete terms.

You will be given the full session transcript. Write a summary as follows.

If the transcript has no substantive content (it is empty, or holds only a slash-command such as /clear or /resume, boilerplate, or local-command output with no real conversation or work), do not ask for a transcript and do not invent activity. Output exactly two lines: "(No substantive session content.)" then "Keywords: (none)".

First line: one sentence stating what the session was about and where it happened (name the repo, service, or project when identifiable).

Then a few tight sentences of plain prose covering what actually happened: what was explored, built, changed, fixed, decided, or discussed. Adapt to the session. Most sessions are routine work (grinding through tickets, small edits, quick lookups) with no significant decision, and that is fine. Do not manufacture importance. A routine session deserves one or two sentences; a substantial design or debugging session deserves a short paragraph. Never pad, never invent.

Mention decisions, rationale, trade-offs, or unfinished/open threads only when they genuinely occurred. If nothing was decided and nothing was left open, leave both out.

Preserve concrete, searchable terms verbatim: file paths, package and service names, function and symbol names, ticket ids (e.g. VKT-1234), URLs, commands, and key technical or domain concepts. These are how the session gets found later.

Last line: a single line beginning "Keywords:" with a compact comma-separated list of the concrete things the session touched (files, paths, packages, services, tickets, tools, concepts). Keep identifiers verbatim. For a pure discussion with nothing concrete, list the main topics instead.

Write in the session's dominant language (Swedish or English). Be terse. Output only the summary itself: no preamble, no heading, no sign-off, no markdown formatting.`;

// The 5.x tokenizer measured 2.1-2.4 bytes/token on real transcripts; 2 errs low
// so the cap keeps headroom instead of overflowing on a dense thread.
const BYTES_PER_TOKEN = 2;

// claude -p adds ~40k tokens of measured fixed overhead (tools, CLAUDE.md);
// without this reserve a thread that fits on size still fails with
// "Prompt is too long".
const RESERVED_CONTEXT_TOKENS = 60_000;

const MODEL_CONTEXT_TOKENS = 1_000_000;

export const DIGEST_INPUT_MAX_BYTES =
  (MODEL_CONTEXT_TOKENS - RESERVED_CONTEXT_TOKENS) * BYTES_PER_TOKEN;

// Both default models take the full 1M window, so this is a quality line, not a
// context limit: the routing the old 200k Haiku forced. Haiku 5.5 was measured
// fine near it, but on a ~1M-token thread it answered the transcript instead of
// summarizing it.
const DEFAULT_ESCALATION_BYTES = 330_000;

export interface DigestModelConfig {
  small: string;
  large: string;
  thresholdBytes: number;
}

export const DEFAULT_DIGEST_MODELS: DigestModelConfig = {
  small: "claude-haiku-5-5",
  large: "claude-sonnet-5-5",
  thresholdBytes: DEFAULT_ESCALATION_BYTES,
};

export const pickDigestModel = (byteCount: number, models: DigestModelConfig): string =>
  byteCount > models.thresholdBytes ? models.large : models.small;

interface RenderableMessage {
  role: string;
  ts: string | null;
  text: string;
  is_sidechain: number;
}

const renderHeader = (message: RenderableMessage): string => {
  const tag = message.is_sidechain ? " · subagent" : "";
  return `──── ${message.role}${tag} · ${message.ts ?? ""} ────\n`;
};

const truncationNote = (droppedBytes: number): string =>
  `\n[+${droppedBytes} bytes truncated for digest]`;

// Walks code points, so the kept prefix never ends inside a multi-byte sequence
// or between the halves of a surrogate pair.
const sliceToBytes = (text: string, maxBytes: number): string => {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
};

export const buildDigestInput = (
  messages: RenderableMessage[],
  maxBytes = DIGEST_INPUT_MAX_BYTES,
): string => {
  const headers = messages.map(renderHeader);
  const bodies = messages.map((message) => message.text);
  const bodyBytes = bodies.map((body) => Buffer.byteLength(body));
  const fixed = headers.reduce((sum, header) => sum + Buffer.byteLength(header) + 2, 0);
  const total = fixed + bodyBytes.reduce((sum, bytes) => sum + bytes, 0);

  const render = (cap: number | null): string =>
    messages
      .map((_message, i) => {
        const body = bodies[i]!;
        if (cap === null || bodyBytes[i]! <= cap) return `${headers[i]}${body}\n`;
        // The note is charged to the cap so the block stays within it. Reserving
        // against the whole body is safe, since the dropped count can never have
        // more digits than the body's own byte length.
        const kept = sliceToBytes(body, cap - truncationNote(bodyBytes[i]!).length);
        return `${headers[i]}${kept}${truncationNote(bodyBytes[i]! - Buffer.byteLength(kept))}\n`;
      })
      .join("\n");

  if (total <= maxBytes) return render(null);

  // Largest cap C with sum(min(bytes, C)) <= bodyBudget, by binary search.
  const bodyBudget = Math.max(0, maxBytes - fixed);
  let lo = 0;
  let hi = bodyBytes.reduce((max, bytes) => Math.max(max, bytes), 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const used = bodyBytes.reduce((sum, bytes) => sum + Math.min(bytes, mid), 0);
    if (used <= bodyBudget) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
};
