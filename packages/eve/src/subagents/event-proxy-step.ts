import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  applyHumanInputEvents,
  type HumanInputEnding,
} from "#harness/human-input/effects/index.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { HumanInput, type Transition } from "#harness/human-input/index.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import { createTurnWaitingEvent } from "#protocol/message.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

type ProxiedSubagentEvent = PublishedSessionEvents & { readonly ending?: HumanInputEnding };

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepState & {
    readonly runId?: string;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<WithSessionStateDelta<ProxiedSubagentEvent>> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      runId: target.runId,
      hookPayload: target.hookPayload,
    }),
  );
}

/**
 * Relays one child event through the parent session. A child's sign-in
 * completes on its own callback, so its events only reach the channel; a
 * child's question is human input. `runId` names the workflow tool run that
 * relayed the question.
 */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & {
    readonly runId?: string;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<ProxiedSubagentEvent> {
  const { hookPayload, runId } = input;
  let transition: Transition | undefined;
  const { published, result } = await publishFromSessionStep(input, {
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
        return undefined;
      }
      const { event } = hookPayload;
      transition = HumanInput.read(session.state).interrupt({
        at: { sequence: event.sequence, stepIndex: event.stepIndex, turnId: event.turnId },
        requests: event.requests,
        route: {
          childContinuationToken: hookPayload.childContinuationToken,
          ...(runId !== undefined && { runId }),
        },
        type: "relayed.requested",
      });
      return await applyHumanInputEvents(emit, transition.events);
    },
    updateSession(session, ending) {
      if (transition === undefined) return { session };
      return {
        result: ending,
        session: { ...session, state: transition.humanInput.write(session.state) },
      };
    },
  });
  return result === undefined ? published : { ...published, ending: result };
}
