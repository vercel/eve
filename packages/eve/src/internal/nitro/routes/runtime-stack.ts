import type { Runtime } from "#channel/types.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import type { App } from "#runtime/app.js";
import { resolveRemoteAgentStreamHeaders } from "#execution/agent-sessions/remote.js";
import type { RemoteAgentStreamHeadersResolver } from "#internal/nitro/routes/channel-route-context.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";

interface NitroChannelRuntimeBundle {
  readonly agentName: string;
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly resolveRemoteAgentStreamHeaders?: RemoteAgentStreamHeadersResolver;
  readonly runtime: Runtime;
}

export function appSessionRuntime(app: App, config: SessionRuntimeConfig): Runtime {
  return sessionRuntime(app.durable, app.hosts, config);
}

export async function resolveNitroChannelRuntimeBundle(
  config: NitroArtifactsConfig,
  app: App,
): Promise<NitroChannelRuntimeBundle> {
  const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(config);
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource,
  });
  const runtime = appSessionRuntime(app, { compiledArtifactsSource });
  return {
    agentName: bundle.resolvedAgent.config?.name ?? "eve",
    channels: bundle.graph.root.channels,
    resolveRemoteAgentStreamHeaders: async (input) =>
      await resolveRemoteAgentStreamHeaders({ bundle, ...input }),
    runtime,
  };
}
