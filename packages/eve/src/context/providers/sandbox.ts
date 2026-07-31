import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { readSubagentSandboxAncestorStates } from "#execution/subagent-adapter.js";
import type { HarnessSession } from "#harness/types.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { type ChannelAdapter, getAdapterKind } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { SandboxKey, SessionIdKey, SessionKey, TurnAbortSignalKey } from "#context/keys.js";
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
    const sessionId = ctx.require(SessionIdKey);
    const channel = ctx.get(ChannelKey);
    const { parentState, rootState } = readSubagentSandboxAncestorStates(channel);
    const activeSession = ctx.require(SessionKey);

    return {
      value: await ensureSandboxAccess({
        compiledArtifactsSource: bundle.compiledArtifactsSource,
        context: ctx,
        nodeId: node.nodeId,
        parentState,
        registry,
        rootState,
        signal: ctx.get(TurnAbortSignalKey),
        session: {
          auth: activeSession.auth,
          id: activeSession.sessionId,
          parent: activeSession.parent,
          turn: activeSession.turn,
        },
        sessionId,
        state: session.sandboxState ?? null,
        tags: {
          agent: resolveTagAgentName({ bundle, node }),
          channel: resolveTagChannelKind(channel),
          sessionId,
        },
      }),
    };
  },

  async commit(access, session) {
    const state = await access.captureState();
    if (state === null) {
      return session;
    }
    return { ...session, sandboxState: state };
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
