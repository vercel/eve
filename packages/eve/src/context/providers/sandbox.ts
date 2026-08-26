import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { HarnessSession } from "#harness/types.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import { type ChannelAdapter, getAdapterKind } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { contextStorage } from "#context/container.js";
import { DefaultSandboxOwnerNodeIdKey, SandboxKey, SessionIdKey } from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { FrameworkContextProvider } from "#context/provider.js";

export const sandboxProvider: FrameworkContextProvider<SandboxAccess> = {
  key: SandboxKey,

  async create(ctx: ContextContainer, session: HarnessSession) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const registry = node.sandboxRegistry;
    const ownerNodeId = registry.sandbox?.inheritance?.nodeId ?? node.nodeId;
    const defaultOwnerNodeId = ctx.get(DefaultSandboxOwnerNodeIdKey) ?? ownerNodeId;
    const sessionId = ctx.require(SessionIdKey);
    const channel = ctx.get(ChannelKey);
    const adapterState = channel?.state as Record<string, unknown> | undefined;
    const parentSandboxState = adapterState?.parentSandboxState as SandboxState | undefined;
    const inheritsParent = registry.sandbox?.definition.inheritsParent === true;
    const sharedSandboxSessionId = adapterState?.sandboxSessionId as string | undefined;
    const sharesSandbox = inheritsParent || sharedSandboxSessionId !== undefined;
    const sandboxSessionId = sharesSandbox ? (sharedSandboxSessionId ?? sessionId) : sessionId;

    const sandboxStates =
      session.sandboxStates ??
      (session.sandboxState === undefined ? {} : { [defaultOwnerNodeId]: session.sandboxState });
    const persistedState = sandboxStates[ownerNodeId];
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: bundle.compiledArtifactsSource,
      nodeId: node.nodeId,
      registry,
      runOnSession: async (callback) => await contextStorage.run(ctx, callback),
      sessionId: sandboxSessionId,
      state: persistedState ?? (sharesSandbox ? parentSandboxState : undefined) ?? null,
      tags: {
        agent: resolveTagAgentName({ bundle, node }),
        channel: resolveTagChannelKind(channel),
        sessionId,
      },
    });
    const { sandboxState: _previousSandboxState, ...sessionWithoutSandboxState } = session;
    return {
      value: access,
      session:
        persistedState === undefined
          ? { ...sessionWithoutSandboxState, sandboxStates }
          : { ...sessionWithoutSandboxState, sandboxState: persistedState, sandboxStates },
    };
  },

  async commit(access, session, ctx) {
    const state = await access.captureState();
    const node = getActiveRuntimeNode(ctx);
    const ownerNodeId = node.sandboxRegistry.sandbox?.inheritance?.nodeId ?? node.nodeId;
    return {
      ...session,
      sandboxState: state,
      sandboxStates: { ...session.sandboxStates, [ownerNodeId]: state },
    };
  },
};

function resolveTagAgentName(input: {
  readonly bundle: CompiledBundle;
  readonly node: ReturnType<typeof getActiveRuntimeNode>;
}): string {
  const partialNode = input.node as {
    readonly agent?: { readonly config?: { readonly name?: string } };
    readonly nodeId?: string;
  };
  const partialBundle = input.bundle as {
    readonly resolvedAgent?: { readonly config?: { readonly name?: string } };
  };

  return (
    partialNode.agent?.config?.name ??
    partialBundle.resolvedAgent?.config?.name ??
    partialNode.nodeId ??
    "unknown"
  );
}

function resolveTagChannelKind(channel: ChannelAdapter | undefined): string {
  return channel === undefined ? "unknown" : getAdapterKind(channel);
}
