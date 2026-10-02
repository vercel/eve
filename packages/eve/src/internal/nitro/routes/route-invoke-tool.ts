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
import type { InvokeToolTraceOrigin } from "#tracing/invoke-tool-span.js";

/**
 * Builds the route's `invokeTool`. The agent's static tools and sandbox load on
 * the first call, so routes that never invoke a tool pay nothing.
 */
export function createRouteInvokeTool(input: {
  readonly config: NitroArtifactsConfig;
  /** The channel this route belongs to; trace policy classifies calls by it. */
  readonly origin?: InvokeToolTraceOrigin;
  readonly requestUrl: string;
}): InvokeToolFn {
  let runtime: Promise<InvokeToolRuntime> | undefined;
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
      input.origin === undefined ? loaded : { ...loaded, origin: input.origin },
      name,
      toolInput,
      options,
    );
  };
}

/** Loads the root agent's static tools and sandbox. Dynamic resolvers are not run. */
export async function loadInvokeToolRuntime(input: {
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<InvokeToolRuntime> {
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
