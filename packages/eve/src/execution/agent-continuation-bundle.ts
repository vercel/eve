import type { RuntimeAgentHandleAction } from "#execution/agent-handle-dispatch.js";
import { resolveRemoteAgentForAction } from "#execution/remote-agent-dispatch.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";

type DynamicRemoteAgentConfig = NonNullable<
  Extract<
    ReturnType<typeof getDynamicSubagentSelection>,
    { readonly kind: "remote" }
  >["remoteAgent"]
>;

/** Overlays current dynamic credentials without replacing stored delivery coordinates. */
export function createAgentContinuationBundle(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly bundle: CompiledBundle;
  readonly remoteConfig?: DynamicRemoteAgentConfig;
}): CompiledBundle {
  const { action, remoteConfig } = input;
  if (
    action.kind !== "remote-agent-call" ||
    action.remoteTarget?.kind === "inline" ||
    remoteConfig === undefined
  ) {
    return input.bundle;
  }

  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const subagentsByNodeId = Object.assign(new Map(registry), {
    get: (nodeId: string) =>
      nodeId === action.nodeId
        ? {
            definition: resolveRemoteAgentForAction({
              dynamicRemoteAgent: remoteConfig,
              nodeId,
              registry,
              remoteAgentName: action.remoteAgentName,
            }),
          }
        : registry.get(nodeId),
  });

  return {
    ...input.bundle,
    subagentRegistry: { ...input.bundle.subagentRegistry, subagentsByNodeId },
  };
}
