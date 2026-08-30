// Public surface: code outside src/digest imports from here, never the internals.
export { DIGEST_PROMPT_SIGNATURE } from "../digest-signature.ts";
export { type DigestConfig, digestConfigFromEnv } from "./config.ts";
export {
  buildDigestInput,
  DEFAULT_DIGEST_MODELS,
  DIGEST_INPUT_MAX_CHARS,
  DIGEST_PROMPT,
  DIGEST_PROMPT_VERSION,
  type DigestModelConfig,
  pickDigestModel,
} from "./prompt.ts";
export {
  createClaudeSummarizer,
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
