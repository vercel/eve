import type { InvokeToolFn } from "#channel/invoke-tool.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { InvokeToolTraceOrigin } from "#tracing/eve/invoke-tool-span.js";

/**
 * Builds the route's `invokeTool`. The agent's static tools and sandbox load on
 * the first call, so routes that never invoke a tool pay nothing.
 */
export function createRouteInvokeTool(input: {
  /** The agent's name, on every call's span and in its trace policy input. */
  readonly agentName: string;
  readonly config: NitroArtifactsConfig;
  /** The channel this route belongs to; trace policy classifies calls by it. */
  readonly origin?: InvokeToolTraceOrigin;
  readonly requestUrl: string;
}): InvokeToolFn {
  let runtime: Promise<LoadedInvokeToolRuntime> | undefined;
  return async (name, toolInput, options) => {
    runtime ??= loadInvokeToolRuntime({
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(new URL(input.requestUrl).origin),
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

/** The part of `InvokeToolRuntime` that comes from the compiled agent. */
export type LoadedInvokeToolRuntime = Omit<InvokeToolRuntime, "agentName" | "origin">;

/** Loads the root agent's static tools and sandbox. Dynamic resolvers are not run. */
export async function loadInvokeToolRuntime(input: {
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<LoadedInvokeToolRuntime> {
  const { compiledArtifactsSource } = input;
  const [bundle, manifest] = await Promise.all([
    getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
    loadCompiledManifest({ compiledArtifactsSource }),
  ]);
  const node = bundle.graph.root;
  return {
    bundle,
    callbackBaseUrl: input.callbackBaseUrl,
    compiledArtifactsSource,
    manifest,
    nodeId: node.nodeId,
    sandboxRegistry: node.sandboxRegistry,
    tools: createNodeHarnessTools({ node }),
  };
}
