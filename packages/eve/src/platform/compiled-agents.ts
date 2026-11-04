// Agents compiled from files, read from their artifacts on this host's disk. `compiled-agents.web.ts`
// is the browser's twin, which has no compiled artifacts; the package's `#platform/*` imports pick
// one by the `node` condition.
export { loadCompiledManifest } from "#runtime/loaders/manifest.js";
/** A compiled app's node (the root by default), loaded once per process. */
export { getCompiledRuntimeAgentBundle as loadCompiledBundle } from "#runtime/sessions/compiled-agent-cache.js";
export {
  compiledSessionAgent,
  loadCompiledSessionAgent,
} from "#runtime/sessions/compiled-session-agent.js";
