import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";

// Nitro's default `codeSplitting` group names chunks with a function and no
// `debugName`. Newer Rolldown releases warn about the missing timing label on
// every build, while older releases in Nitro's range reject the key, so eve
// cannot set it for Nitro.
const MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME = "MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME";

/** Bundler log handler for eve's Nitro host builds. */
export function onNitroBundlerLog<Level extends string, Log>(
  level: Level,
  log: Log,
  defaultHandler: (level: Level, log: Log) => void,
): void {
  if (
    level === "warn" &&
    (log as { code?: unknown } | null)?.code === MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME
  ) {
    return;
  }
  onVendoredDependencyLog(level, log, defaultHandler);
}
