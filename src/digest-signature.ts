// The opening sentence of DIGEST_PROMPT, in its own leaf module (no imports) so
// the indexer can recognize cerebro's own summarization runs without pulling in
// the digest layer. Rewording it stops digest transcripts already on disk from
// being detected on a `--full` re-read.
export const DIGEST_PROMPT_SIGNATURE =
  "You are summarizing a single Claude Code session for a personal, full-text-searchable archive.";
