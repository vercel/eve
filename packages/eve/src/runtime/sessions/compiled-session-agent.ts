import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  type CompiledRuntimeAgentBundle,
  getCompiledRuntimeAgentBundle,
} from "#runtime/sessions/compiled-agent-cache.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";

export async function compiledSessionAgent(
  bundle: CompiledRuntimeAgentBundle,
): Promise<SessionAgent> {
  const { fromCompiledBundle } = await import("#definitions/compiled-agent.js");
  return fromCompiledBundle(bundle);
}

export async function loadCompiledSessionAgent(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}): Promise<SessionAgent> {
  return await compiledSessionAgent(await getCompiledRuntimeAgentBundle(input));
}
