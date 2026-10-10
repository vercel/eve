import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type {
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { callProgress } from "#harness/call-facts.js";
import { createAgentStartedEvent } from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

/** Publishes a workflow tool run's `ctx.report()` update as the call's progress. */
export async function emitWorkflowToolRunReportStep(
  input: SessionStepState & {
    readonly from: WorkflowToolRunRef;
    readonly update: JsonValue;
  },
): Promise<SessionStateTransition> {
  "use step";

  const event = callProgress(input.from.callId, input.update);
  return await withSessionStateDelta(input, (target) => publishSessionEvents(target, [event]));
}

/** Publishes `agent.started`, in order, for sessions workflow tool runs opened. */
export async function emitAgentStartedStep(
  input: SessionStepState & {
    readonly messages: readonly WorkflowToolRunAgentStartedMessage[];
  },
): Promise<SessionStateTransition> {
  "use step";

  const events = input.messages.map(({ from, session }) =>
    createAgentStartedEvent({
      callId: from.callId,
      name: session.name,
      parentSessionId: input.sessionState.sessionId,
      remote:
        session.kind === "remote"
          ? {
              url: session.url,
              ...(session.resolverId !== undefined && { resolverId: session.resolverId }),
            }
          : undefined,
      sessionId: session.sessionId,
      ...(from.taskId !== undefined && { taskId: from.taskId }),
      turnId: from.turnId,
    }),
  );
  return await withSessionStateDelta(input, (target) => publishSessionEvents(target, events));
}
