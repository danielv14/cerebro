// The digest package's public surface: everything the former single-file digest
// module exported, re-exported from its concerns so callers change only the
// import path. prompt.ts owns the summarization contract and model tiering,
// stale.ts owns the staleness predicate and the coverage reading, store.ts owns
// summary storage plus the summary full-text search, run.ts owns the summarize
// pipeline and the seam the model call sits behind.
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
