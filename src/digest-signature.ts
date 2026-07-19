// The opening sentence of DIGEST_PROMPT, in its own leaf module (no imports) so the
// indexer can recognize cerebro's own headless `claude -p` summarization runs
// without pulling in the digest layer. Those runs are recorded by Claude Code as
// ordinary sessions under ~/.claude/projects, and their first user message is the
// digest prompt verbatim; the indexer matches on this prefix to refuse to index
// them (see isDigestRunTranscript in indexer.ts). Keep it as the literal start of
// DIGEST_PROMPT: if you reword the opening, historical digest transcripts on disk
// stop being detected on a `--full` re-read.
export const DIGEST_PROMPT_SIGNATURE =
  "You are summarizing a single Claude Code session for a personal, full-text-searchable archive.";
