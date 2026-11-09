import { ensureSandboxAccess, type EnsuredSandboxAccess } from "#execution/sandbox/ensure.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import type { ContextContainer } from "#context/container.js";
import { SandboxKey, SandboxTerminalCleanupKey, SessionIdKey } from "#context/keys.js";
import { ChannelKey, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { runtimeNodeId } from "#runtime/sessions/session-agent.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import type { SessionPrewarmer } from "#context/prewarm.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("context.sandbox");

/**
 * Starts a prewarmed session's sandbox, and resumes a sandbox the session
 * already recorded when a turn begins. A turn never starts a sandbox: every
 * agent has one, and most turns may not need it.
 */
export const sandboxPrewarmer: SessionPrewarmer = {
  name: "sandbox",
  start(ctx, phase) {
    // `sandboxProvider.create` built this step's access.
    const access = ctx.get(SandboxKey) as EnsuredSandboxAccess | undefined;
    if (phase === "session") access?.prepare();
    else access?.resumeRecorded();
  },
};

export const sandboxProvider: FrameworkContextProvider<SandboxAccess> = {
  key: SandboxKey,

  async create(ctx: ContextContainer, session: HarnessSessionBase) {
    const agent = ctx.get(SessionAgentKey);
    const sandbox = await agent?.sandbox();
    if (agent === undefined || sandbox === undefined) return undefined;
    const { registry } = sandbox;
    const sessionId = ctx.require(SessionIdKey);
    // A child that shares its parent's sandbox finds it on its channel: the subagent adapter's state.
    const adapterState = sandbox.sharesParent
      ? (ctx.get(ChannelKey)?.state as Record<string, unknown> | undefined)
      : undefined;
    const parentSandboxState = adapterState?.parentSandboxState as SandboxState | undefined;
    const inheritsParent = registry.sandbox?.definition.kind === "parent";
    const ownerSandboxSessionId = adapterState?.sandboxSessionId as string | undefined;
    const reusesOwnerSandbox = inheritsParent || ownerSandboxSessionId !== undefined;
    const sandboxSessionId = reusesOwnerSandbox ? (ownerSandboxSessionId ?? sessionId) : sessionId;

    const access = await ensureSandboxAccess({
      ...sandbox.template,
      nodeId: runtimeNodeId(agent),
      ownsSandbox: !reusesOwnerSandbox,
      registry,
      sessionId: sandboxSessionId,
      state: session.sandboxState ?? (reusesOwnerSandbox ? parentSandboxState : undefined) ?? null,
    });
    ctx.setVirtualContext(SandboxTerminalCleanupKey, (reason) => access.end(reason));
    return { value: access };
  },

  async commit(access, session) {
    await (access as EnsuredSandboxAccess).settle();
    const state = await access.captureState();
    return { ...session, sandboxState: state };
  },

  // Closes the connection the step opened; `create` built the access.
  async dispose(access) {
    await (access as EnsuredSandboxAccess).release().catch((error: unknown) => {
      logError(log, "failed to close a step's sandbox connection", error);
    });
  },
};
