import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ContextReader } from "#context/provider.js";

/**
 * Returns the active runtime node from the compiled bundle on the
 * context. The bundle is already resolved to the correct node (root or
 * subagent) at run start.
 */
export function getActiveRuntimeNode(ctx: ContextReader) {
  return ctx.require(BundleKey).graph.root;
}
