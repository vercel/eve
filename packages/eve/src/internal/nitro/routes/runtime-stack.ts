import type { Runtime } from "#channel/types.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  getCompiledRuntimeAgentBundle,
  type CompiledRuntimeAgentBundle,
} from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { installEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

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
 * Bundle shared by Nitro routes that need to start or resume workflow sessions.
 */
export interface NitroWorkflowRuntimeStack {
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly runtime: Runtime;
}

/**
 * Creates the workflow runtime stack for a resolved compiled artifact source.
 *
 * No singleton caching is needed — session state lives inside the
 * workflow's durable execution and the compiled bundle cache is versioned by
 * the compiled artifacts source.
 */
export async function createNitroWorkflowRuntimeStack(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<NitroWorkflowRuntimeStack> {
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource,
  });
  installEveWorkflowQueueNamespace(bundle.graph.root.agent.config.name);
  const runtime = createWorkflowRuntime({ compiledArtifactsSource });
  return { bundle, runtime };
}

/**
 * Resolves the workflow runtime stack for package-owned Nitro routes.
 */
export async function resolveNitroWorkflowRuntimeStack(
  config: NitroArtifactsConfig,
): Promise<NitroWorkflowRuntimeStack> {
  return await createNitroWorkflowRuntimeStack(resolveNitroCompiledArtifactsSource(config));
}

/**
 * Resolves the per-request channel bundle: the agent's resolved channels
 * (already merged with framework defaults by `resolve-agent-graph.ts`)
 * and a fresh workflow runtime.
 */
export async function resolveNitroChannelRuntimeBundle(
  config: NitroArtifactsConfig,
): Promise<NitroChannelRuntimeBundle> {
  const { bundle, runtime } = await resolveNitroWorkflowRuntimeStack(config);
  return {
    channels: bundle.graph.root.channels,
    runtime,
  };
}
