import {
  ensureSandboxAccess,
  sandboxIdleTimeoutMs,
  type EnsuredSandboxAccess,
} from "#execution/sandbox/ensure.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import type { ContextContainer } from "#context/container.js";
import { SandboxKey, SandboxTerminalCleanupKey, SessionIdKey } from "#context/keys.js";
import { ChannelKey, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { runtimeNodeId, type SessionAgent } from "#runtime/sessions/session-agent.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import type { SessionPrewarmer } from "#context/prewarm.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("context.sandbox");

export const sandboxPrewarmer: SessionPrewarmer = {
  name: "sandbox",
  start(ctx, phase) {
    if (phase !== "session") return;
    const access = ctx.get(SandboxKey) as EnsuredSandboxAccess | undefined;
    if (access?.idleTimeoutMs === 0) return;
    access?.prepare();
  },
};

async function selectSessionSandbox(input: {
  readonly agent: SessionAgent | undefined;
  readonly channelState: unknown;
  readonly sessionId: string;
}) {
  const sandbox = await input.agent?.sandbox();
  if (input.agent === undefined || sandbox === undefined) return undefined;
  const adapterState = input.channelState as Record<string, unknown> | undefined;
  const parentSandboxState = adapterState?.parentSandboxState as SandboxState | undefined;
  const inheritsParent = sandbox.registry.sandbox?.definition.kind === "parent";
  const ownerSandboxSessionId = adapterState?.sandboxSessionId as string | undefined;
  const reusesOwnerSandbox = inheritsParent || ownerSandboxSessionId !== undefined;
  return {
    agent: input.agent,
    ownsSandbox: !reusesOwnerSandbox,
    parentSandboxState: reusesOwnerSandbox ? parentSandboxState : undefined,
    sandbox,
    sandboxSessionId: reusesOwnerSandbox
      ? (ownerSandboxSessionId ?? input.sessionId)
      : input.sessionId,
  };
}

export async function sessionSandboxIdleTimeoutMs(input: {
  readonly agent: SessionAgent | undefined;
  readonly channelState: unknown;
  readonly sandboxState: SandboxState | undefined;
  readonly sessionId: string;
}): Promise<number | undefined> {
  const selected = await selectSessionSandbox(input);
  if (selected === undefined || !selected.ownsSandbox) return undefined;
  return sandboxIdleTimeoutMs(
    selected.sandbox.registry,
    selected.sandboxSessionId,
    input.sandboxState?.session,
  );
}

export const sandboxProvider: FrameworkContextProvider<SandboxAccess> = {
  key: SandboxKey,

  async create(ctx: ContextContainer, session: HarnessSessionBase) {
    const selected = await selectSessionSandbox({
      agent: ctx.get(SessionAgentKey),
      channelState: ctx.get(ChannelKey)?.state,
      sessionId: ctx.require(SessionIdKey),
    });
    if (selected === undefined) return undefined;
    const { agent, sandbox } = selected;

    const access = await ensureSandboxAccess({
      ...sandbox.template,
      nodeId: runtimeNodeId(agent),
      ownsSandbox: selected.ownsSandbox,
      registry: sandbox.registry,
      sessionId: selected.sandboxSessionId,
      state: session.sandboxState ?? selected.parentSandboxState ?? null,
    });
    ctx.setVirtualContext(SandboxTerminalCleanupKey, (reason) => access.end(reason));
    return { value: access };
  },

  async commit(access, session) {
    await (access as EnsuredSandboxAccess).settle();
    const state = await access.captureState();
    return { ...session, sandboxState: state };
  },

  async dispose(access) {
    await (access as EnsuredSandboxAccess).release().catch((error: unknown) => {
      logError(log, "failed to close a step's sandbox connection", error);
    });
  },
};
