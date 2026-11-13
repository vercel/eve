import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  agentSessionsOver,
  type LocalAgentSessions,
} from "#execution/agent-sessions/sessions-over.js";
import type {
  AgentSessionMessage,
  AgentSessionOpenInput,
  AgentSessionReceipt,
  OpenedAgentSession,
  StartedAgentSession,
} from "#execution/agent-sessions/start.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeSessionStartHook } from "#execution/session-inbox/resume.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
  dispatchWorkflowSessionCommand,
  resolveContinuation,
} from "#execution/workflow-runtime.js";

// A run's agent sessions on Workflow: each operation is a step of the run, a local child is a
// durable run of its own, and a delivery is named by the step that sends it.

const WORKFLOW_LOCAL_SESSIONS: LocalAgentSessions = {
  async start(prepared, { context }) {
    const childRuntime = createWorkflowRuntime(prepared.runtime);
    // The child inherits none of the calling step's session lineage.
    const started = await contextStorage.run(
      new ContextContainer({ localDevRequest: context.localDevRequest }),
      () => childRuntime.createSession(prepared.runInput),
    );
    // The start claims the child's address, so a retried attempt is refused and
    // names the run an earlier attempt started.
    return { address: prepared.address(started.sessionId), deliveryId: prepared.deliveryId };
  },
  /**
   * A session's start claimed its address, so it takes commands before it boots and a refusal
   * means it ended. A session opened by an earlier eve may have lost its address to a duplicate
   * start, and the command then goes to the session holding its continuation.
   */
  async command(opened, command) {
    const { continuationToken, sessionId } = opened.address;
    const result = await dispatchWorkflowSessionCommand({ command, sessionId });
    if (result.status === "accepted" || result.status === "reset") return result;
    const current = (await resolveContinuation(continuationToken))?.sessionId;
    if (current === undefined || current === sessionId) return result;
    return await dispatchWorkflowSessionCommand({ command, sessionId: current });
  },
  async commandLate(sessionId, command) {
    // Waiting for a booting inbox would hold the parent's next turn. A child
    // whose start claimed its address takes the command there before it boots.
    try {
      await resumeHook(sessionInboxHookToken(sessionCommandHookToken(sessionId)), command);
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      if ((await resumeSessionStartHook(sessionId, command)) === undefined) throw error;
    }
  },
};

const workflowAgentSessions = agentSessionsOver({
  deliveryId: (kind, sessionId) =>
    `agent-session:${getWorkflowMetadata().workflowRunId}:${getStepMetadata().stepId}:${sessionId}:${kind}`,
  local: WORKFLOW_LOCAL_SESSIONS,
  remote: { callbackBaseUrl: () => resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url) },
});

/**
 * Opens a run's session with its first message, as a child of the call whose
 * `context` it binds. `key` names the handle within the run, so a retried step
 * reaches the same session instead of a second one.
 */
export async function openAgentSessionStep(
  input: AgentSessionOpenInput,
): Promise<StartedAgentSession> {
  "use step";

  return await workflowAgentSessions.open(input);
}

/**
 * Sends a later message; it joins the session's running turn or starts the
 * next. It keeps the session's lineage and carries its own auth.
 */
export async function sendAgentSessionMessageStep(
  input: AgentSessionMessage & OpenedAgentSession,
): Promise<AgentSessionReceipt> {
  "use step";

  return await workflowAgentSessions.send(input);
}

/** Cancels a session's running turn; the turn still reports, as cancelled. */
export async function cancelAgentSessionTurnStep(input: OpenedAgentSession): Promise<void> {
  "use step";

  await workflowAgentSessions.cancelTurn(input);
}

/** Ends a run's sessions when the run finishes, cancelling any turn still running. */
export async function endAgentSessionsStep(input: {
  readonly sessions: readonly OpenedAgentSession[];
}): Promise<void> {
  "use step";

  await workflowAgentSessions.end(input);
}

/** Best-effort cleanup for a late address whose cancelled run cannot own it. */
export async function stopLateAgentSessionStep(opened: OpenedAgentSession): Promise<void> {
  "use step";

  await workflowAgentSessions.stopLate(opened);
}
