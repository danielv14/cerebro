// Build identity, baked into the compiled binary so a deployed snapshot can say
// what it was built from.
//
// The automated paths (the SessionEnd/clear hook, the scheduled reconciler) run a
// *compiled* binary at $CLAUDE_CONFIG_DIR/cerebro/cerebro, not the source, so a code
// change does not reach them until `bun run deploy`. Without a stamp that drift is
// invisible: there is no way to ask the deployed binary what it contains. `cerebro
// version` prints this, and `cerebro doctor` compares it against the repo.
//
// The three identifiers below are substituted by `bun build --define` (see the
// build script in package.json). They deliberately do NOT exist when running from
// source: `typeof` on an undeclared identifier is legal and yields "undefined", so a
// plain `bun run src/cli.ts` reports itself as unbuilt rather than claiming a commit
// it does not have.
declare const __CEREBRO_VERSION__: string;
declare const __CEREBRO_COMMIT__: string;
declare const __CEREBRO_BUILT_AT__: string;

const defined = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

export interface BuildStamp {
  version: string;
  // Short git sha, or "unknown" for a source run.
  commit: string;
  // ISO-8601 build time, or "unknown" for a source run.
  builtAt: string;
  bun: string;
  // Whether this is a compiled binary with a real stamp, as opposed to a source run.
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

// The one-line identity `cerebro version` prints and `doctor` compares.
export const buildStampLine = (stamp: BuildStamp): string =>
  `cerebro ${stamp.version} (${stamp.commit}, built ${stamp.builtAt}, bun ${stamp.bun})`;
