import { DIGEST_PROMPT_SIGNATURE } from "../digest-signature.ts";

// Design notes: docs/architecture.md ("Digest"); tiering numbers and overrides:
// docs/digest-model-tiering.md.

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

// 3 errs low (real transcripts run ~3.5-4 bytes/token) so the tiering keeps
// headroom instead of overflowing on a dense thread.
const BYTES_PER_TOKEN = 3;

// claude -p adds ~77k tokens of measured fixed overhead (system prompt, tools,
// response room); without this reserve a thread that fits on size still fails
// with "Prompt is too long".
const RESERVED_CONTEXT_TOKENS = 90_000;

const SMALL_MODEL_CONTEXT_TOKENS = 200_000;
const LARGE_MODEL_CONTEXT_TOKENS = 1_000_000;

const transcriptByteBudget = (contextTokens: number): number =>
  Math.max(0, contextTokens - RESERVED_CONTEXT_TOKENS) * BYTES_PER_TOKEN;

const DEFAULT_HAIKU_MAX_CHARS = transcriptByteBudget(SMALL_MODEL_CONTEXT_TOKENS);

// Final backstop so even the 1M model never overflows; pickDigestModel is the
// primary size control.
export const DIGEST_INPUT_MAX_CHARS = transcriptByteBudget(LARGE_MODEL_CONTEXT_TOKENS);

export interface DigestModelConfig {
  small: string;
  large: string;
  thresholdChars: number;
}

// The shipped tiering. config.ts layers the env overrides on top of it.
export const DEFAULT_DIGEST_MODELS: DigestModelConfig = {
  small: "claude-haiku-4-5",
  // The [1m] suffix is what actually buys the 1M window; without it the model
  // answers on 200k and a large thread overflows.
  large: "claude-sonnet-4-6[1m]",
  thresholdChars: DEFAULT_HAIKU_MAX_CHARS,
};

// Bytes, not characters, so multibyte threads tier correctly; `>` is strict so a
// thread exactly at the threshold stays on the small model.
export const pickDigestModel = (byteCount: number, models: DigestModelConfig): string =>
  byteCount > models.thresholdChars ? models.large : models.small;

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

// Below budget every message renders verbatim (identical to `show --full`).
// Above it, a water-fill caps each body to a fair share: short messages stay
// whole while the longest essays are trimmed first.
export const buildDigestInput = (
  messages: RenderableMessage[],
  maxChars = DIGEST_INPUT_MAX_CHARS,
): string => {
  const headers = messages.map(renderHeader);
  const bodies = messages.map((message) => message.text);
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

  // Largest cap C with sum(min(len, C)) <= bodyBudget, by binary search. The
  // truncation markers are bounded and inside the headroom baked into maxChars.
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
