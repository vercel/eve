// Where a sandbox keeps its files on this host, and the prepared template a compiled agent's
// sandbox starts from. `sandbox-cache.web.ts` is the browser's twin; the package's `#platform/*`
// imports pick one by the `node` condition.
export { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
export { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
