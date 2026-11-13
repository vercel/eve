import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  type CompiledRuntimeAgentBundle,
  getCompiledRuntimeAgentBundle,
} from "#runtime/sessions/compiled-agent-cache.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";

/**
 * A compiled node's agent. Its definitions module (every file feature's definition) loads where a
 * session first needs it, so the context keys that carry the agent don't import every definition.
 */
export async function compiledSessionAgent(
  bundle: CompiledRuntimeAgentBundle,
): Promise<SessionAgent> {
  const { fromCompiledBundle } = await import("#definitions/compiled-agent.js");
  return fromCompiledBundle(bundle);
}

/** The compiled agent at `nodeId` (the root by default) of a compiled app. */
export async function loadCompiledSessionAgent(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}): Promise<SessionAgent> {
  return await compiledSessionAgent(await getCompiledRuntimeAgentBundle(input));
}
