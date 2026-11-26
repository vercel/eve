import { ContextContainer, contextStorage, type AlsContext } from "#context/container.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionKey,
  SteeredByKey,
} from "#context/keys.js";
import { ownerReference } from "#execution/agent-sessions/owner.js";
import {
  cancelBashJobOnSandbox,
  pollBashJobOnSandbox,
  timeoutBashJobOnSandbox,
  type BashCompletedResult,
  type BashJobHandoff,
} from "#execution/sandbox/bash.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type {
  WorkflowStepContext,
  WorkflowStepSandbox,
} from "#execution/tools/workflow/step-context.js";
import {
  getDevelopmentWorkflowGeneration,
  withDevelopmentWorkflowGeneration,
} from "#runtime/development-generation.js";
import { resolveSessionAgent } from "#runtime/sessions/runtime-context-keys.js";
import { runtimeNodeId, type SessionAgent } from "#runtime/sessions/session-agent.js";
import type { SandboxState } from "#sandbox/state.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

type BashJobStepSession = WorkflowStepContext["session"];

export type PollBashJobResult =
  | { readonly atMs: number; readonly status: "running" }
  | { readonly result: BashCompletedResult; readonly status: "completed" };

export async function pollBashJobStep(
  sandboxRef: WorkflowStepSandbox,
  session: BashJobStepSession,
  handoff: BashJobHandoff,
): Promise<PollBashJobResult> {
  "use step";

  return await withStepSandbox(sandboxRef, session, async (sandbox) => {
    const polled = await pollBashJobOnSandbox(sandbox, handoff);
    return polled.status === "running" ? { atMs: Date.now(), status: "running" } : polled;
  });
}

export async function cancelBashJobStep(
  sandboxRef: WorkflowStepSandbox,
  session: BashJobStepSession,
  handoff: BashJobHandoff,
): Promise<void> {
  "use step";

  await withStepSandbox(sandboxRef, session, (sandbox) => cancelBashJobOnSandbox(sandbox, handoff));
}

export async function timeoutBashJobStep(
  sandboxRef: WorkflowStepSandbox,
  session: BashJobStepSession,
  handoff: BashJobHandoff,
  message: string,
): Promise<BashCompletedResult> {
  "use step";

  return await withStepSandbox(sandboxRef, session, (sandbox) =>
    timeoutBashJobOnSandbox(sandbox, handoff, message),
  );
}

export async function cancelBashJobForAgent(input: {
  readonly agent: SessionAgent;
  readonly handoff: BashJobHandoff;
  readonly sandboxSessionId: string;
  readonly sandboxState: SandboxState | undefined;
}): Promise<void> {
  try {
    const sandbox = await input.agent.sandbox();
    if (sandbox === undefined) return;
    const access = await ensureSandboxAccess({
      ...sandbox.template,
      nodeId: runtimeNodeId(input.agent),
      ownsSandbox: false,
      registry: sandbox.registry,
      sessionId: input.sandboxSessionId,
      state: input.sandboxState ?? null,
      shutdownTracking: "none",
    });
    try {
      const active = await access.get();
      if (active !== null) await cancelBashJobOnSandbox(active, input.handoff);
    } finally {
      await access.release();
    }
  } catch {}
}

function populateStepContext(store: AlsContext, session: BashJobStepSession): void {
  const { steeredBy } = session.auth;
  store.set(AuthKey, session.auth.current);
  store.set(InitiatorAuthKey, session.auth.initiator);
  if (steeredBy !== undefined && steeredBy.length > 0) store.set(SteeredByKey, steeredBy);
  store.set(SessionIdKey, session.id);
  store.setVirtualContext(SessionKey, { ...session, sessionId: session.id });
}

async function withStepSandbox<T>(
  sandboxRef: WorkflowStepSandbox,
  session: BashJobStepSession,
  work: (sandbox: SandboxSession) => Promise<T>,
): Promise<T> {
  const generation = getDevelopmentWorkflowGeneration();
  const run = async (): Promise<T> => {
    const store = contextStorage.getStore();
    if (store !== undefined) populateStepContext(store, session);
    const agent = await resolveSessionAgent(ownerReference(sandboxRef));
    const sandbox = await agent.sandbox();
    if (sandbox === undefined) {
      throw new Error("The session's agent has no sandbox.");
    }
    const access = await ensureSandboxAccess({
      ...sandbox.template,
      nodeId: runtimeNodeId(agent),
      ownsSandbox: false,
      registry: sandbox.registry,
      sessionId: sandboxRef.sessionId,
      state: sandboxRef.state ?? null,
      shutdownTracking: "none",
    });
    try {
      const active = await access.get();
      if (active === null) {
        throw new Error("The session's sandbox could not be opened.");
      }
      return await work(active);
    } finally {
      await access.release();
    }
  };
  if (generation !== undefined) {
    return await withDevelopmentWorkflowGeneration(generation, run);
  }
  return await contextStorage.run(new ContextContainer(), run);
}
