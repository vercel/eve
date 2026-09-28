import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

/**
 * Creates eve-owned Nitro bundler overrides that must apply to both Rollup
 * and Rolldown hosted builds.
 */
export function createNitroBundlerConfig(plugins: readonly object[]): Record<string, unknown> {
  return {
    onLog: onVendoredDependencyLog,
    plugins: [createNodeEsmCompatBannerPlugin(), ...plugins],
  };
}
