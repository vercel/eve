import type { InvokeToolFn } from "#channel/invoke-tool.js";
import { withAgentApprovalOnEntries } from "#approval/agent.js";
import { resolveAgentApproval } from "#execution/effective-agent-config.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import type { Build } from "#platform/entities.js";
import type { App } from "#runtime/app.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { InvokeToolTraceOrigin } from "#tracing/eve/invoke-tool-span.js";

export function createRouteInvokeTool(input: {
  readonly agentName: string;
  readonly app: App;
  readonly config: NitroArtifactsConfig;
  readonly origin?: InvokeToolTraceOrigin;
  readonly requestUrl: string;
}): InvokeToolFn {
  let runtime: Promise<LoadedInvokeToolRuntime> | undefined;
  return async (name, toolInput, options) => {
    runtime ??= loadInvokeToolRuntime({
      build: input.app.platform.build,
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(
        new URL(input.requestUrl).origin,
        input.app.platform,
      ),
      compiledArtifactsSource: resolveNitroCompiledArtifactsSource(input.config),
    }).catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
    const loaded = await runtime;
    return await invokeTool(
      { ...loaded, agentName: input.agentName, origin: input.origin },
      name,
      toolInput,
      options,
    );
  };
}

export type LoadedInvokeToolRuntime = Omit<InvokeToolRuntime, "agentName" | "origin">;

export async function loadInvokeToolRuntime(input: {
  readonly build: Build;
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<LoadedInvokeToolRuntime> {
  const { compiledArtifactsSource } = input;
  const [bundle, manifest] = await Promise.all([
    getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
    loadCompiledManifest({ compiledArtifactsSource }),
  ]);
  const node = bundle.graph.root;
  const tools = withAgentApprovalOnEntries(
    createNodeHarnessTools({ node }),
    resolveAgentApproval(bundle),
  );
  return {
    build: input.build,
    bundle,
    callbackBaseUrl: input.callbackBaseUrl,
    compiledArtifactsSource,
    manifest,
    nodeId: node.nodeId,
    sandboxRegistry: node.sandboxRegistry,
    tools,
  };
}
