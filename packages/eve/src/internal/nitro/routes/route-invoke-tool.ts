import type { InvokeToolFn } from "#channel/invoke-tool.js";
import { withAgentApprovalOnEntries } from "#approval/agent.js";
import { resolveAgentApproval } from "#execution/effective-agent-config.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { materializeCompiledArtifactsSource } from "#runtime/compiled-artifacts-override.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { InvokeToolTraceOrigin } from "#tracing/eve/invoke-tool-span.js";

export function createRouteInvokeTool(input: {
  readonly agentName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly origin?: InvokeToolTraceOrigin;
  readonly requestUrl: string;
}): InvokeToolFn {
  let runtime: Promise<LoadedInvokeToolRuntime> | undefined;
  return async (name, toolInput, options) => {
    runtime ??= loadInvokeToolRuntime({
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(new URL(input.requestUrl).origin),
      compiledArtifactsSource: input.compiledArtifactsSource,
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
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<LoadedInvokeToolRuntime> {
  const { compiledArtifactsSource } = input;
  await materializeCompiledArtifactsSource(compiledArtifactsSource);
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
    bundle,
    callbackBaseUrl: input.callbackBaseUrl,
    compiledArtifactsSource,
    manifest,
    nodeId: node.nodeId,
    sandboxRegistry: node.sandboxRegistry,
    tools,
  };
}
