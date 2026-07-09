import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { HarnessSession } from "#harness/types.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import { type ChannelAdapter, getAdapterKind } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { ContextContainer as MutableContextContainer, contextStorage } from "#context/container.js";
import {
  InheritedSandboxKey,
  SandboxKey,
  SandboxOwnerDynamicSkillNamesKey,
  SandboxOwnerStaticSkillNamesKey,
  type Session,
  SessionIdKey,
  SessionKey,
  StaticSkillNamesKey,
} from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import type { SandboxBackendHandle } from "#public/definitions/sandbox-backend.js";

const INHERITED_SANDBOX_FALLBACK_TURN = Object.freeze({ id: "sandbox-session", sequence: 0 });

export const sandboxProvider: FrameworkContextProvider<SandboxAccess> = {
  key: SandboxKey,

  async create(ctx: ContextContainer, session: HarnessSession) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const sessionId = ctx.require(SessionIdKey);
    const channel = ctx.get(ChannelKey);
    const adapterState = channel?.state as Record<string, unknown> | undefined;
    const sandboxSessionId = (adapterState?.sandboxSessionId as string | undefined) ?? sessionId;
    const parentSandboxState = adapterState?.parentSandboxState as SandboxState | undefined;
    const sandboxNode = resolveSandboxRuntimeNode({
      bundle,
      node,
      sandboxNodeId: adapterState?.sandboxNodeId,
    });
    const registry = sandboxNode.sandboxRegistry;
    ctx.setVirtualContext(
      SandboxOwnerStaticSkillNamesKey,
      resolveSandboxStaticSkillNames({ bundle, sandboxNode }),
    );
    ctx.setVirtualContext(
      SandboxOwnerDynamicSkillNamesKey,
      readSandboxOwnerDynamicSkillNames(adapterState?.sandboxOwnerDynamicSkillNames),
    );
    ctx.setVirtualContext(
      InheritedSandboxKey,
      sandboxSessionId !== sessionId || sandboxNode.nodeId !== node.nodeId,
    );

    return {
      value: await ensureSandboxAccess({
        compiledArtifactsSource: bundle.compiledArtifactsSource,
        nodeId: sandboxNode.nodeId,
        registry,
        runOnSession: async (callback, handle) =>
          await contextStorage.run(
            createSandboxOwnerContext({
              bundle,
              ctx,
              handle,
              node: sandboxNode,
              sessionId: sandboxSessionId,
            }),
            callback,
          ),
        sessionId: sandboxSessionId,
        state: session.sandboxState ?? parentSandboxState ?? null,
        tags: {
          agent: resolveTagAgentName({ bundle, node: sandboxNode }),
          channel: resolveTagChannelKind(channel),
          sessionId,
        },
      }),
    };
  },

  async commit(access, session) {
    const state = await access.captureState();
    return { ...session, sandboxState: state };
  },
};

function resolveSandboxRuntimeNode(input: {
  readonly bundle: CompiledBundle;
  readonly node: ReturnType<typeof getActiveRuntimeNode>;
  readonly sandboxNodeId: unknown;
}): ReturnType<typeof getActiveRuntimeNode> {
  if (typeof input.sandboxNodeId !== "string") {
    return input.node;
  }

  return input.bundle.graph.nodesByNodeId.get(input.sandboxNodeId) ?? input.node;
}

function createSandboxOwnerContext(input: {
  readonly bundle: CompiledBundle;
  readonly ctx: ContextContainer;
  readonly handle: SandboxBackendHandle;
  readonly node: ResolvedRuntimeAgentNode;
  readonly sessionId: string;
}): ContextContainer {
  const ownerContext = cloneDurableContext(input.ctx);
  const ownerBundle = createBundleForNode(input.bundle, input.node);
  ownerContext.set(BundleKey, ownerBundle);
  ownerContext.set(SessionIdKey, input.sessionId);
  ownerContext.set(
    StaticSkillNamesKey,
    input.node.agent.skills.map((skill) => skill.name),
  );

  const activeSession = input.ctx.get(SessionKey);
  if (activeSession !== undefined) {
    ownerContext.setVirtualContext(
      SessionKey,
      createSandboxOwnerSession(activeSession, input.sessionId),
    );
  }

  ownerContext.setVirtualContext(SandboxKey, {
    captureState: async () => ({
      initialized: true,
      session: await input.handle.captureState(),
    }),
    get: async () => input.handle.session,
  });

  return ownerContext;
}

function resolveSandboxStaticSkillNames(input: {
  readonly bundle: CompiledBundle;
  readonly sandboxNode: ResolvedRuntimeAgentNode;
}): readonly string[] {
  const sandbox = input.sandboxNode.sandboxRegistry.sandbox as
    | ResolvedRuntimeAgentNode["sandboxRegistry"]["sandbox"]
    | null;
  if (sandbox === null) {
    return input.sandboxNode.agent?.skills?.map((skill) => skill.name) ?? [];
  }

  const mergedResourceRoots = new Set(
    sandbox.workspaceResourceRoots.map((root) => root.logicalPath),
  );
  const names = new Set<string>();

  for (const node of input.bundle.graph.nodesByNodeId.values()) {
    const logicalPath = node.agent?.workspaceResourceRoot?.logicalPath;
    if (logicalPath === undefined || !mergedResourceRoots.has(logicalPath)) {
      continue;
    }

    for (const skill of node.agent.skills ?? []) {
      names.add(skill.name);
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

function readSandboxOwnerDynamicSkillNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const names = new Set<string>();
  for (const name of value) {
    if (typeof name === "string" && name.length > 0) {
      names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function createSandboxOwnerSession(activeSession: Session, ownerSessionId: string): Session {
  if (activeSession.sessionId === ownerSessionId) {
    return activeSession;
  }

  return {
    auth: activeSession.auth,
    sessionId: ownerSessionId,
    turn:
      activeSession.parent?.sessionId === ownerSessionId
        ? activeSession.parent.turn
        : INHERITED_SANDBOX_FALLBACK_TURN,
  };
}

function cloneDurableContext(ctx: ContextContainer): ContextContainer {
  const clone = new MutableContextContainer();
  for (const [key, value] of ctx.entries()) {
    clone.set(key, value);
  }
  return clone;
}

function createBundleForNode(
  bundle: CompiledBundle,
  node: ResolvedRuntimeAgentNode,
): CompiledBundle {
  return {
    ...bundle,
    graph: {
      nodesByNodeId: bundle.graph.nodesByNodeId,
      root: node,
    },
    hookRegistry: node.hookRegistry,
    nodeId: node.nodeId === ROOT_RUNTIME_AGENT_NODE_ID ? undefined : node.nodeId,
    resolvedAgent: node.agent,
    subagentRegistry: node.subagentRegistry,
    toolRegistry: node.toolRegistry,
    turnAgent: node.turnAgent,
  };
}

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
