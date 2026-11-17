import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ContextReader } from "#context/provider.js";

export function getActiveRuntimeNode(ctx: ContextReader) {
  return ctx.require(BundleKey).graph.root;
}
