import { ensureSandboxAccess, type EnsureSandboxAccessInput } from "#execution/sandbox/ensure.js";
import type { HarnessSession } from "#harness/types.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import { SandboxKey, SessionIdKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { ContextReader, FrameworkContextProvider } from "#context/provider.js";

export const sandboxProvider: FrameworkContextProvider<SandboxAccess> = {
  key: SandboxKey,

  async create(ctx, session) {
    const input = resolveSandboxAccessInput(ctx, session);
    if (input === undefined) return undefined;
    return { value: await ensureSandboxAccess(input) };
  },

  async commit(access, session) {
    const state = await access.captureState();
    return { ...session, sandboxState: state };
  },
};

export function resolveSandboxAccessInput(
  ctx: ContextReader,
  session: HarnessSession,
): EnsureSandboxAccessInput | undefined {
  const bundle = ctx.get(BundleKey);
  if (bundle === undefined) return undefined;
  const node = getActiveRuntimeNode(ctx);
  const registry = node.sandboxRegistry;
  const sessionId = ctx.require(SessionIdKey);
  const channel = ctx.get(ChannelKey);
  const adapterState = channel?.state as Record<string, unknown> | undefined;
  const parentSandboxState = adapterState?.parentSandboxState as SandboxState | undefined;
  const inheritsParent = registry.sandbox?.definition.kind === "parent";
  const ownerSandboxSessionId = adapterState?.sandboxSessionId as string | undefined;
  const reusesOwnerSandbox = inheritsParent || ownerSandboxSessionId !== undefined;
  const sandboxSessionId = reusesOwnerSandbox ? (ownerSandboxSessionId ?? sessionId) : sessionId;
  return {
    compiledArtifactsSource: bundle.compiledArtifactsSource,
    nodeId: node.nodeId,
    ownsSandbox: !reusesOwnerSandbox,
    registry,
    sessionId: sandboxSessionId,
    state: session.sandboxState ?? (reusesOwnerSandbox ? parentSandboxState : undefined) ?? null,
  };
}
