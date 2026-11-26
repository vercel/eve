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
  isBashJobHandoff,
  pollBashJobOnSandbox,
  timeoutBashJobOnSandbox,
  type BashCompletedResult,
  type BashJobHandoff,
} from "#execution/sandbox/bash.js";
import { bashJobTaskWorkflowReference } from "#execution/sandbox/bash-job-reference.js";
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
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

type BashJobStepSession = WorkflowStepContext["session"];

type PollBashJobResult =
  | { readonly atMs: number; readonly status: "running" }
  | { readonly result: BashCompletedResult; readonly status: "completed" };

interface BashJobSandboxTarget {
  readonly agent: SessionAgent;
  readonly sandboxSessionId: string;
  readonly sandboxState: SandboxState | undefined;
}

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

export async function cancelUndispatchedBashTasks(
  tasks: readonly RuntimeWorkflowTaskRequest[],
  resolveTarget: () => Promise<BashJobSandboxTarget> | BashJobSandboxTarget,
): Promise<void> {
  const handoffs = tasks.flatMap((task) =>
    task.workflowId === bashJobTaskWorkflowReference.workflowId &&
    isBashJobHandoff(task.executeInput)
      ? [task.executeInput]
      : [],
  );
  if (handoffs.length === 0) return;
  try {
    const target = await resolveTarget();
    await withAgentSandbox(target, async (sandbox) => {
      await Promise.allSettled(handoffs.map((handoff) => cancelBashJobOnSandbox(sandbox, handoff)));
    });
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

async function withAgentSandbox<T>(
  target: BashJobSandboxTarget,
  work: (sandbox: SandboxSession) => Promise<T>,
): Promise<T> {
  const sandbox = await target.agent.sandbox();
  if (sandbox === undefined) throw new Error("The session's agent has no sandbox.");
  const access = await ensureSandboxAccess({
    ...sandbox.template,
    nodeId: runtimeNodeId(target.agent),
    ownsSandbox: false,
    registry: sandbox.registry,
    sessionId: target.sandboxSessionId,
    state: target.sandboxState ?? null,
    shutdownTracking: "none",
  });
  try {
    const active = await access.get();
    if (active === null) throw new Error("The session's sandbox could not be opened.");
    return await work(active);
  } finally {
    await access.release();
  }
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
    return await withAgentSandbox(
      { agent, sandboxSessionId: sandboxRef.sessionId, sandboxState: sandboxRef.state },
      work,
    );
  };
  if (generation !== undefined) {
    return await withDevelopmentWorkflowGeneration(generation, run);
  }
  return await contextStorage.run(new ContextContainer(), run);
}
