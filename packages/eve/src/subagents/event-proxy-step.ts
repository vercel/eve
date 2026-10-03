import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { applyHumanInputEvents } from "#harness/human-input/effects/index.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { HumanInput, type Transition } from "#harness/human-input/index.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import { createTurnWaitingEvent } from "#protocol/message.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepState & RelayedBy & { readonly hookPayload: SubagentEventHookPayload },
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      control: target.control,
      runId: target.runId,
      hookPayload: target.hookPayload,
    }),
  );
}

/** The workflow tool run that relayed a question, and its control hook when the question is its own `ctx.ask()`. */
interface RelayedBy {
  readonly control?: string;
  readonly runId?: string;
}

/**
 * Relays one child event through the parent session. A child's sign-in
 * completes on its own callback, so its events only reach the channel; a
 * child's question is human input.
 */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & RelayedBy & { readonly hookPayload: SubagentEventHookPayload },
): Promise<PublishedSessionEvents> {
  const { control, hookPayload, runId } = input;
  let transition: Transition | undefined;
  const { published } = await publishFromSessionStep(input, {
    origin: "relayed",
    inputSource:
      hookPayload.kind === "subagent-input-request"
        ? JSON.stringify([hookPayload.childContinuationToken, hookPayload.inputSource ?? null])
        : undefined,
    async publish(emit, session) {
      if (hookPayload.kind === "subagent-authorization-event") {
        await emit(hookPayload.event);
        if (hookPayload.event.type === "authorization.required") {
          const turn = getHarnessEmissionState(session.state);
          await emit(
            createTurnWaitingEvent({
              on: "input",
              sequence: turn.sequence,
              turnId: turn.turnId,
              usage: getSessionUsage(session),
            }),
          );
        }
        return;
      }
      const { event } = hookPayload;
      transition = HumanInput.read(session.state).interrupt({
        at: { sequence: event.sequence, stepIndex: event.stepIndex, turnId: event.turnId },
        requests: event.requests,
        route: {
          childContinuationToken: hookPayload.childContinuationToken,
          // The address names the child only when it is the child's own inbox.
          ...(hookPayload.childSessionInbox?.sessionId === hookPayload.childSessionId && {
            childSessionInbox: hookPayload.childSessionInbox,
          }),
          ...(hookPayload.remote !== undefined && { remote: hookPayload.remote }),
          ...(hookPayload.inputSource !== undefined && { inputSource: hookPayload.inputSource }),
          ...(runId !== undefined && { runId }),
          ...(control !== undefined && { control }),
        },
        ...(event.taskId !== undefined && { taskId: event.taskId }),
        type: "relayed.requested",
      });
      await applyHumanInputEvents(emit, transition.events, session);
    },
    updateSession(session) {
      if (transition === undefined) return { session };
      return { session: { ...session, state: transition.humanInput.write(session.state) } };
    },
  });
  return published;
}
