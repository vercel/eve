import type { SubagentInteractionHookPayload } from "#channel/types.js";
import {
  commitSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepInput,
} from "#execution/publish-session-events.js";
import { type SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { readHitlState } from "#harness/hitl/index.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import {
  callsBackFor,
  ownCallbacks,
  settleSignIns,
  signInsAnswered,
  signInsEnded,
  type SignInAnswer,
  type SignInEnding,
} from "#harness/hitl/index.js";
import { relay, relayedMirror } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { sessionSignInCallbacks, signInDelivery } from "#execution/hosts.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/** Relays one child interaction fact through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepInput & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentInteractionHookPayload;
  },
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      workflowAsk: target.workflowAsk,
      runId: target.runId,
      hookPayload: target.hookPayload,
    }),
  );
}

/**
 * Relays one child interaction fact through the parent session's channel. `runId` names the
 * workflow tool run that relayed it, so the session can withdraw its requests when that run ends.
 */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentInteractionHookPayload;
  },
): Promise<PublishedSessionEvents> {
  const { hookPayload, runId, workflowAsk } = input;
  // The other askers hear a sign-in's answer before the relay commits: a delivery that fails
  // fails this step, and its retry delivers them again from the same state.
  const { sessionId } = input.durableSession;
  const callbacks = sessionSignInCallbacks(sessionId);
  const own =
    callbacks === undefined ? undefined : ownCallbacks(sessionId, callbacks.callbackBaseUrl);
  if (callbacks !== undefined && own !== undefined) {
    const tables = storedProjection(input.durableSession.state).view;
    await settleSignIns(signInDelivery(callbacks.deliver), [
      ...relayedAnswers(tables, hookPayload).flatMap((answer) =>
        signInsAnswered(tables, answer, own),
      ),
      ...relayedEndings(tables, hookPayload).flatMap((ending) => signInsEnded(tables, ending, own)),
    ]);
  }
  return await commitSessionStep(
    input,
    (view) => [
      relay(view, {
        callsBack: own === undefined ? undefined : callsBackFor(own),
        payload: hookPayload,
        relays: readHitlState(input.durableSession.state).relays,
        runId,
        workflowAsk,
      }),
    ],
    {
      origin: "relayed",
      inputSource:
        hookPayload.route === undefined
          ? undefined
          : JSON.stringify([
              hookPayload.route.childContinuationToken,
              hookPayload.route.inputSource ?? null,
            ]),
    },
  );
}

/** The answers in a child's relayed events to sign-ins this session mirrors for that child. */
export function relayedAnswers(
  tables: SessionView,
  payload: SubagentInteractionHookPayload,
): readonly SignInAnswer[] {
  return payload.events.flatMap((event) => {
    if (event.type !== "interaction.settled") return [];
    const { interactionId, outcome } = event.data;
    if (outcome !== "accepted" && outcome !== "declined") return [];
    const answered = relayedMirror(tables, payload, interactionId);
    const signIn = answered?.request.signIn;
    if (answered?.status !== "open" || signIn === undefined) return [];
    return [{ interactionId, outcome, signIn }];
  });
}

/** The relayed sign-ins this session mirrors for the child that ended without an answer. */
function relayedEndings(
  tables: SessionView,
  payload: SubagentInteractionHookPayload,
): readonly SignInEnding[] {
  return payload.events.flatMap((event) => {
    if (event.type !== "interaction.settled") return [];
    const { interactionId, outcome } = event.data;
    if (outcome === "accepted" || outcome === "declined") return [];
    const ended = relayedMirror(tables, payload, interactionId);
    if (ended?.status !== "open" || ended.request.signIn === undefined) return [];
    return [{ interactionId, reason: event.data.reason ?? outcome }];
  });
}
