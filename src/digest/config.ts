import { DEFAULT_DIGEST_MODELS, type DigestModelConfig } from "./prompt.ts";

// The env overrides and the numbers behind them: docs/digest-model-tiering.md.

// Generous on purpose: a large thread legitimately takes minutes, and a timeout
// on a slow-but-alive call wastes a finished summary.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface DigestConfig {
  models: DigestModelConfig;
  timeoutMs: number;
  claudeBin: string;
}

// The one place cerebro reads the digest environment. The CLI edge calls it and
// passes the result down, so nothing in the pipeline reaches for process.env.
export const digestConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): DigestConfig => {
  // The env var keeps _CHARS while the field it feeds is thresholdBytes: the
  // name shipped and is someone's hook config. This is the one place the two
  // meet, so do not "fix" either to match the other.
  const threshold = env.CEREBRO_DIGEST_HAIKU_MAX_CHARS;
  const parsedThreshold = threshold ? Number(threshold) : DEFAULT_DIGEST_MODELS.thresholdBytes;
  const parsedTimeout = Number(env.CEREBRO_DIGEST_TIMEOUT_MS);
  return {
    models: {
      small: env.CEREBRO_DIGEST_MODEL || DEFAULT_DIGEST_MODELS.small,
      large: env.CEREBRO_DIGEST_MODEL_LARGE || DEFAULT_DIGEST_MODELS.large,
      // A non-numeric override falls back rather than becoming NaN, which would
      // wedge every thread on the small model.
      thresholdBytes: Number.isFinite(parsedThreshold)
        ? parsedThreshold
        : DEFAULT_DIGEST_MODELS.thresholdBytes,
    },
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
    claudeBin: env.CEREBRO_CLAUDE_BIN || "claude",
  };
};
