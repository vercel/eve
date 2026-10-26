import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { applyTaskRunMessage, type TaskRunMessage } from "#execution/tasks/steps.js";
import type {
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  createActionPartialEvent,
  createAgentStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

/** A workflow tool run's `ctx.report()` update, as `action.partial`. */
function workflowToolRunReportEvent(
  from: WorkflowToolRunRef,
  update: JsonValue,
): UnstampedMessageStreamEvent {
  return createActionPartialEvent({
    result: createRuntimeToolResultFromValue({
      callId: from.callId,
      output: update,
      toolName: from.toolName,
    }),
    sequence: from.sequence,
    stepIndex: from.stepIndex,
    turnId: from.turnId,
  });
}

/** `agent.started` for a session a workflow tool run opened. */
function agentStartedEvent(
  parentSessionId: string,
  { from, session }: WorkflowToolRunAgentStartedMessage,
): UnstampedMessageStreamEvent {
  return createAgentStartedEvent({
    callId: from.callId,
    name: session.name,
    parentSessionId,
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
  });
}

/** A run's message the session applies as it reads it, which answers no call a turn waits on. */
export type AppliedRunMessage =
  | Extract<WorkflowToolRunMessage, { readonly kind: "agent-started" | "report" }>
  // Only a task's run reports these to the task table; an `execute` run's outcome answers its call.
  | (TaskRunMessage & { readonly from: { readonly taskId: string } });

/**
 * Applies run messages in the order they arrived, in one step however many
 * there are: a fan-out's starts, reports, and replies would otherwise cost a
 * step each. Set `canCancelTurn` while a turn runs: a hook's `ctx.cancel()`
 * on a report then returns `cancelled` for the turn to stop.
 */
export async function applyRunMessagesStep(
  input: SessionStepState & {
    readonly canCancelTurn?: boolean;
    readonly messages: readonly AppliedRunMessage[];
  },
): Promise<SessionStateTransition & { readonly cancelled: boolean }> {
  "use step";
  return await withSessionStateDelta(input, async ({ canCancelTurn, messages, ...target }) => {
    let state: SessionStepState = target;
    let cancelled = false;
    // Consecutive starts and reports publish together, as one turn's events do.
    let events: UnstampedMessageStreamEvent[] = [];
    const publish = async (): Promise<void> => {
      if (events.length === 0) return;
      const published = await publishSessionEvents(state, events, { canCancelTurn });
      state = {
        ...state,
        serializedContext: published.serializedContext,
        sessionState: published.sessionState,
      };
      cancelled ||= published.cancelled;
      events = [];
    };
    for (const message of messages) {
      if (message.kind === "agent-started") {
        events.push(agentStartedEvent(state.sessionState.sessionId, message));
      } else if (message.kind === "report") {
        events.push(workflowToolRunReportEvent(message.from, message.update));
      } else {
        await publish();
        state = { ...state, ...(await applyTaskRunMessage({ ...state, message })) };
      }
    }
    await publish();
    return {
      cancelled,
      serializedContext: state.serializedContext,
      sessionState: state.sessionState,
    };
  });
}
