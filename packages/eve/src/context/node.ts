import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ContextReader } from "#context/provider.js";
import { createSkillStoreLocation, type SkillStoreLocation } from "#runtime/skills/store.js";
import { resolveAgentHome } from "#runtime/workspace/types.js";

/**
 * Returns the active runtime node from the compiled bundle on the
 * context. The bundle is already resolved to the correct node (root or
 * subagent) at run start.
 */
export function getActiveRuntimeNode(ctx: ContextReader) {
  return ctx.require(BundleKey).graph.root;
}

/**
 * Agent home directory for the active node, or undefined when the node
 * owns its sandbox and uses the shared roots (`/workspace`, real `$HOME`).
 */
export function getActiveAgentHome(ctx: ContextReader): string | undefined {
  const node = ctx.get(BundleKey)?.graph?.root;
  if (node === undefined) return undefined;
  return node.sandboxRegistry?.sandbox?.definition.inheritsParent === true
    ? resolveAgentHome(node.nodeId)
    : undefined;
}

/** Storage configuration bound to the active agent home. */
export function getActiveSkillStoreLocation(ctx: ContextReader): SkillStoreLocation {
  return createSkillStoreLocation({ home: getActiveAgentHome(ctx) });
}
