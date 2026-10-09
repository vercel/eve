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

  const event = callProgress(input.from.callId, input.update);
  return await withSessionStateDelta(input, (target) => publishSessionEvents(target, [event]));
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
