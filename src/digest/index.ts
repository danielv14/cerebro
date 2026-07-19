// The digest package's public surface: everything the former single-file digest
// module exported, re-exported from its three concerns so callers change only the
// import path. prompt.ts owns the summarization contract and model tiering,
// stale.ts owns the staleness predicate, store.ts owns summary storage and search.
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
export { countStaleThreads, type StaleThread, staleThreads } from "./stale.ts";
export {
  getSummary,
  rejectSummaryReason,
  type StoredSummary,
  SUMMARY_MIN_CHARS,
  type SummaryHit,
  searchSummaries,
  writeSummary,
} from "./store.ts";
