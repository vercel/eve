import type { AppHosts } from "#execution/hosts.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import type { OpenedAgentSession } from "#execution/agent-sessions/start.js";
import type { RemoteChildBinding } from "#execution/child-binding.js";
import {
  publishSessionEvents,
  type SessionStepInput,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { type SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { applyTaskRunMessage, type TaskRunMessage } from "#execution/tasks/steps.js";
import { isActiveTaskRun, readTaskTable } from "#execution/tasks/table.js";
import type {
  WorkflowToolRunAgentSentMessage,
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { callProgress } from "#harness/call-facts.js";
import { openChild, recordChildSent } from "#harness/session-machine/children.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { Commit, SessionPublication } from "#harness/types.js";
import type { Progress } from "#protocol/session-events/facts.js";
import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

function workflowToolRunReportEvents(
  state: SessionStepState,
  from: WorkflowToolRunRef,
  update: JsonValue,
): Progress[] {
  const { view } = storedProjection(readDurableSession(state.sessionState).state);
  const call = view?.calls[from.callId];
  const settled = view !== undefined && (call === undefined || call.status === "settled");
  return settled ? [] : [callProgress(from.callId, update)];
}

async function childOpenedEvent(
  children: RunMessageChildren,
  parentSessionId: string,
  { from, session }: WorkflowToolRunAgentStartedMessage,
): Promise<Commit> {
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
    if (session.dynamicBinding !== undefined)
      binding.dynamicBinding = parseJsonValue(session.dynamicBinding);
    if (session.earlierProtocol !== undefined) binding.earlierProtocol = session.earlierProtocol;
    await children.recordRemoteBinding(parentSessionId, binding);
  }
  return openChild(
    { name: session.name, owner: { callId: from.callId }, sessionId: session.sessionId, stream },
    { taskId: from.taskId, turnId: from.turnId },
  );
}

function childSentEvent({ deliveryId, from, sessionId }: WorkflowToolRunAgentSentMessage): Commit {
  return recordChildSent(
    { callId: from.callId, childDeliveryId: deliveryId, sessionId },
    { taskId: from.taskId, turnId: from.turnId },
  );
}

export type AppliedRunMessage =
  | Extract<WorkflowToolRunMessage, { readonly kind: "agent-started" | "agent-sent" | "report" }>
  | (TaskRunMessage & { readonly from: { readonly taskId: string } });

export interface RunMessageChildren {
  stopLate(opened: OpenedAgentSession): Promise<void>;
  recordRemoteBinding(parentSessionId: string, binding: RemoteChildBinding): Promise<void>;
}

export type ApplyRunMessagesInput = SessionStepInput & {
  readonly canCancelTurn?: boolean;
  readonly messages: readonly AppliedRunMessage[];
};

export type ApplyRunMessagesResult = SessionStateTransition & { readonly cancelled: boolean };

export function applyRunMessagesOn(
  hosts: AppHosts,
  children: RunMessageChildren,
): (input: ApplyRunMessagesInput) => Promise<ApplyRunMessagesResult> {
  return async (input) =>
    await withSessionStateDelta(hosts, input, async ({ canCancelTurn, messages, ...target }) => {
      let state: SessionStepState = target;
      let cancelled = false;
      let events: SessionPublication[] = [];
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
        const taskId = message.from.taskId;
        const sessionState = readDurableSession(state.sessionState).state;
        const ended =
          taskId !== undefined &&
          (!isActiveTaskRun(readTaskTable(sessionState), taskId, message.from.runId) ||
            storedProjection(sessionState).view?.tasks[taskId]?.status === "ended");
        if (message.kind === "agent-started") {
          if (ended) {
            await children.stopLate({
              address: message.session,
              context: message.context,
              key: message.from.runId,
            });
          } else {
            events.push(await childOpenedEvent(children, state.sessionState.sessionId, message));
          }
        } else if (message.kind === "agent-sent") {
          if (!ended) events.push(childSentEvent(message));
        } else if (message.kind === "report") {
          if (!ended)
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
