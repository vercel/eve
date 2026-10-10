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
import { readDurableSession } from "#execution/durable-session-store.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { recordRemoteChildBinding, type RemoteChildBinding } from "#execution/child-binding.js";
import type { SessionEvent } from "#protocol/session-event.js";
import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import type { JsonValue } from "#shared/json.js";

/** Publishes a workflow tool run's `ctx.report()` update as the call's progress. */
export async function emitWorkflowToolRunReportStep(
  input: SessionStepState & {
    readonly from: WorkflowToolRunRef;
    readonly update: JsonValue;
  },
): Promise<SessionStateTransition> {
  "use step";

  // A run's last report can arrive after its call settled, as when its outcome came first or its
  // turn ended: nobody reads progress for a settled call, so it's dropped.
  const { view } = storedProjection(readDurableSession(input.sessionState).state);
  const call = view?.calls[input.from.callId];
  const settled = view !== undefined && (call === undefined || call.status === "settled");
  const events = settled ? [] : [callProgress(input.from.callId, input.update)];
  return await withSessionStateDelta(input, (target) => publishSessionEvents(target, events));
}

/**
 * Links the sessions workflow tool runs opened, in order: each `child.opened` names the call
 * whose run opened it and the route that serves its stream. A remote child's binding, which
 * names its deployment and credential resolver, goes to a private side stream first.
 */
export async function emitAgentStartedStep(
  input: SessionStepState & {
    readonly messages: readonly WorkflowToolRunAgentStartedMessage[];
  },
): Promise<SessionStateTransition> {
  "use step";

  const parentSessionId = input.sessionState.sessionId;
  const events: SessionEvent[] = [];
  for (const { from, session } of input.messages) {
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
    events.push({
      data: {
        name: session.name,
        owner: { callId: from.callId },
        sessionId: session.sessionId,
        stream,
      },
      scope,
      type: "child.opened",
    });
  }
  return await withSessionStateDelta(input, (target) => publishSessionEvents(target, events));
}
