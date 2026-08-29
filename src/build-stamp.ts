// The three identifiers are substituted by `bun build --define` and deliberately
// do NOT exist when running from source: `typeof` on an undeclared identifier is
// legal, so a source run reports itself as unbuilt rather than claiming a commit
// it does not have.
declare const __CEREBRO_VERSION__: string;
declare const __CEREBRO_COMMIT__: string;
declare const __CEREBRO_BUILT_AT__: string;

const defined = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

export interface BuildStamp {
  version: string;
  commit: string;
  builtAt: string;
  bun: string;
  stamped: boolean;
}

export const buildStamp = (): BuildStamp => {
  const commit = defined(
    typeof __CEREBRO_COMMIT__ === "undefined" ? null : __CEREBRO_COMMIT__,
    "unknown",
  );
  return {
    version: defined(
      typeof __CEREBRO_VERSION__ === "undefined" ? null : __CEREBRO_VERSION__,
      "dev",
    ),
    commit,
    builtAt: defined(
      typeof __CEREBRO_BUILT_AT__ === "undefined" ? null : __CEREBRO_BUILT_AT__,
      "unknown",
    ),
    bun: Bun.version,
    stamped: commit !== "unknown",
  };
};

export const buildStampLine = (stamp: BuildStamp): string =>
  `cerebro ${stamp.version} (${stamp.commit}, built ${stamp.builtAt}, bun ${stamp.bun})`;
