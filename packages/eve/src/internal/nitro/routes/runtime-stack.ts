import type { Runtime } from "#channel/types.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Bundle returned to the per-channel Nitro dispatch handler.
 *
 * Carries the resolved channel set (framework defaults + authored
 * overrides minus authored disables) and the per-request workflow runtime.
 * The dispatch handler walks `channels` to match the inbound request
 * against a registered URL pattern, then calls the matched channel's
 * `fetch` with a `RouteContext` built from `runtime`.
 */
export interface NitroChannelRuntimeBundle {
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly runtime: Runtime;
}

/**
 * Resolves the per-request channel bundle: the agent's resolved channels
 * (already merged with framework defaults by `resolve-agent-graph.ts`)
 * and a fresh workflow runtime.
 *
 * No singleton caching is needed — session state lives inside the
 * workflow's durable execution and the channel set is recomputed from the
 * compiled bundle on each request.
 */
export async function resolveNitroChannelRuntimeBundle(
  config: NitroArtifactsConfig,
): Promise<NitroChannelRuntimeBundle> {
  const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(config);
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource,
  });
  const runtime = createWorkflowRuntime({ compiledArtifactsSource });
  return {
    channels: bundle.graph.root.channels,
    runtime,
  };
}
