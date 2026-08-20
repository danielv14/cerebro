// The digest package's public surface, and the boundary it encodes: code outside
// src/digest imports from here, never from the package's internals, so how the
// package is split (prompt.ts owns the summarization contract and model tiering,
// stale.ts the staleness predicate and coverage reading, store.ts summary storage
// plus the summary full-text search, run.ts the summarize pipeline and the seam
// the model call sits behind) stays a private layout that can change without
// touching a caller.
export { DIGEST_PROMPT_SIGNATURE } from "../digest-signature.ts";
export {
  buildDigestInput,
  DIGEST_INPUT_MAX_CHARS,
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  type DigestModelConfig,
  digestModelConfig,
  pickDigestModel,
} from "./prompt.ts";
export {
  claudeSummarizer,
  type DigestOutcome,
  type DrainResult,
  runDigest,
  runDrain,
  type SummarizeRequest,
  type SummarizeResult,
  type Summarizer,
} from "./run.ts";
export {
  countStaleThreads,
  type StaleThread,
  type SummaryCoverage,
  staleThreads,
  summaryCoverage,
} from "./stale.ts";
export {
  getSummary,
  rejectSummaryReason,
  type StoredSummary,
  SUMMARY_MIN_CHARS,
  type SummaryHit,
  type SummaryRootHit,
  searchSummaries,
  searchSummaryRoots,
  writeSummary,
} from "./store.ts";
