import {
  type BundlerDefaultLogHandler,
  onVendoredDependencyLog,
} from "#internal/bundler/vendored-dependency-log.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

// Nitro's default `codeSplitting` group names chunks with a function and no
// `debugName`. Newer Rolldown releases warn about the missing timing label on
// every build, while older releases in Nitro's range reject the key, so eve
// cannot set it for Nitro.
const MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME = "MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME";

function onNitroBundlerLog(
  level: string,
  log: unknown,
  defaultHandler: BundlerDefaultLogHandler,
): void {
  if (
    level === "warn" &&
    (log as { code?: unknown } | null)?.code === MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME
  ) {
    return;
  }
  onVendoredDependencyLog(level, log, defaultHandler);
}

/**
 * Creates eve-owned Nitro bundler overrides that must apply to both Rollup
 * and Rolldown hosted builds.
 */
export function createNitroBundlerConfig(plugins: readonly object[]): Record<string, unknown> {
  return {
    onLog: onNitroBundlerLog,
    plugins: [createNodeEsmCompatBannerPlugin(), ...plugins],
  };
}
