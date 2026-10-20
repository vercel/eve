import { readDurableSession } from "#execution/durable-session-store.js";
import { recordRemoteChildBinding, type RemoteChildBinding } from "#execution/child-binding.js";
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
import { callProgress } from "#harness/call-facts.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionEvent } from "#protocol/session-event.js";
import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import type { JsonValue } from "#shared/json.js";

/**
 * A workflow tool run's `ctx.report()` update, as its call's progress. A run's last report can
 * arrive after its call settled, as when its outcome came first or its turn ended: nobody reads
 * progress for a settled call, so it's dropped.
 */
function workflowToolRunReportEvents(
  state: SessionStepState,
  from: WorkflowToolRunRef,
  update: JsonValue,
): SessionEvent[] {
  const { view } = storedProjection(readDurableSession(state.sessionState).state);
  const call = view?.calls[from.callId];
  const settled = view !== undefined && (call === undefined || call.status === "settled");
  return settled ? [] : [callProgress(from.callId, update)];
}

/**
 * `child.opened` for a session a workflow tool run opened: it names the call whose run opened
 * it and the route that serves its stream. A remote child's binding, which names its deployment
 * and credential resolver, goes to a private side stream first.
 */
async function childOpenedEvent(
  parentSessionId: string,
  { from, session }: WorkflowToolRunAgentStartedMessage,
): Promise<SessionEvent> {
  const stream =
    session.kind === "remote"
      ? createEveSubagentStreamRoutePath({
          callId: from.callId,
          childSessionId: session.sessionId,
          parentSessionId,
        })
      : createEveSessionStreamRoutePath(session.sessionId);
  if (session.kind === "remote") {
    const binding: { -readonly [K in keyof RemoteChildBinding]: RemoteChildBinding[K] } = {
      callId: from.callId,
      childSessionId: session.sessionId,
      name: session.name,
      streamPath: stream,
      url: session.url,
    };
    if (session.resolverId !== undefined) binding.resolverId = session.resolverId;
    if (session.earlierProtocol !== undefined) binding.earlierProtocol = session.earlierProtocol;
    await recordRemoteChildBinding(parentSessionId, binding);
  }
  const scope: { turnId: string; taskId?: string } = { turnId: from.turnId };
  if (from.taskId !== undefined) scope.taskId = from.taskId;
  return {
    data: {
      name: session.name,
      owner: { callId: from.callId },
      sessionId: session.sessionId,
      stream,
    },
    scope,
    type: "child.opened",
  };
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
    let events: SessionEvent[] = [];
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
        events.push(await childOpenedEvent(state.sessionState.sessionId, message));
      } else if (message.kind === "report") {
        events.push(...workflowToolRunReportEvents(state, message.from, message.update));
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
