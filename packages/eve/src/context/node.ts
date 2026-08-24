import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ContextReader } from "#context/provider.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";

/**
 * Returns the active runtime node from the compiled bundle on the context.
 * The graph retains its canonical application root while `nodeId` selects the
 * root or subagent that owns this execution.
 */
export function getActiveRuntimeNode(ctx: ContextReader) {
  const bundle = ctx.require(BundleKey);
  return getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId);
}
