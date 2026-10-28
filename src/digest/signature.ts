export const DIGEST_PROMPT_SIGNATURE =
  "You are summarizing a single Claude Code session for a personal, full-text-searchable archive.";

const TRANSCRIPT_OPEN = "<transcript>\n";
const TRANSCRIPT_CLOSE =
  "\n</transcript>\n\nWrite the summary of the transcript above, following the instructions in the system prompt.\n";

export const wrapTranscript = (transcript: string): string =>
  `${TRANSCRIPT_OPEN}${transcript}${TRANSCRIPT_CLOSE}`;

// Older runs sent the prompt itself as the user message, and their transcripts
// are still on disk.
export const isDigestInput = (text: string): boolean =>
  text.startsWith(DIGEST_PROMPT_SIGNATURE) ||
  (text.startsWith(TRANSCRIPT_OPEN) && text.endsWith(TRANSCRIPT_CLOSE));
