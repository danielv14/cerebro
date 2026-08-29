// The digest package's public surface: code outside src/digest imports from here,
// never from the package's internals, so the internal split can change without
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
