// The opening sentence of DIGEST_PROMPT, in its own leaf module (no imports) so the
// indexer can recognize cerebro's own headless `claude -p` summarization runs
// without pulling in the digest layer (isDigestRunTranscript in indexer.ts owns the
// how and why). Keep it as the literal start of DIGEST_PROMPT: if you reword the
// opening, digest transcripts already on disk stop being detected on a `--full`
// re-read.
export const DIGEST_PROMPT_SIGNATURE =
  "You are summarizing a single Claude Code session for a personal, full-text-searchable archive.";
