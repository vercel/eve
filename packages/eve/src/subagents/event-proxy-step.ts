import type { SubagentInteractionHookPayload } from "#channel/types.js";
import {
  commitSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { type SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import { SIGN_IN_DECLINED, sameRelayedSignIn } from "#harness/hitl/sign-ins.js";
import {
  callsBackFor,
  localSignInCallback,
  ownCallbacks,
  settleSignIns,
  signInsEnded,
  type AnsweredSignIn,
  type OwnCallbacks,
  type SignInEnding,
} from "#harness/hitl/index.js";
import type { SignInChallenge } from "#protocol/session-events/families/interaction.js";
import { relay } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { resumeSignInCallback } from "#execution/session-inbox/owner.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { debug6086 } from "#runtime/connections/scoped-authorization.js";

/** Relays one child interaction fact through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepState & {
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
  const baseUrl = await workflowCallbackBaseUrl();
  const own =
    baseUrl === undefined ? undefined : ownCallbacks(input.durableSession.sessionId, baseUrl);
  if (own !== undefined) {
    const tables = storedProjection(input.durableSession.state).view;
    debug6086("fanIn", {
      callId: hookPayload.callId,
      events: hookPayload.events.map((event) =>
        event.type === "interaction.settled"
          ? `${event.type}:${event.data.interactionId}:${event.data.outcome}`
          : event.type,
      ),
      own,
      open: Object.values(tables.interactions)
        .filter((row) => row.status === "open" && row.request.signIn !== undefined)
        .map((row) => ({
          id: row.interactionId,
          childSession: row.origin?.sessionId,
          waitsOn: row.request.signIn?.waitsOn,
          local: localSignInCallback(row, own) !== undefined,
        })),
    });
    await settleSignIns(resumeSignInCallback, [
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

/** A sign-in the person answered, and how. */
export interface SignInAnswer {
  readonly interactionId: string;
  readonly signIn: SignInChallenge;
  readonly outcome: "accepted" | "declined";
}

/** This workflow's callback base URL, or `undefined` outside a workflow. */
async function workflowCallbackBaseUrl(): Promise<string | undefined> {
  const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
  const url = getWorkflowMetadata().url;
  return typeof url === "string" ? resolveWorkflowCallbackBaseUrl(url) : undefined;
}

/** The answers in a child's relayed events to sign-ins this session mirrors for that child. */
function relayedAnswers(
  tables: SessionView,
  payload: SubagentInteractionHookPayload,
): readonly SignInAnswer[] {
  return payload.events.flatMap((event) => {
    if (event.type !== "interaction.settled") return [];
    const { interactionId, outcome } = event.data;
    if (outcome !== "accepted" && outcome !== "declined") return [];
    const answered = tables.interactions[interactionId];
    const signIn = answered?.request.signIn;
    if (
      answered?.status !== "open" ||
      answered.origin === undefined ||
      !("callId" in answered.subject) ||
      answered.subject.callId !== payload.callId ||
      signIn === undefined
    )
      return [];
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
    const ended = tables.interactions[interactionId];
    if (
      ended?.status !== "open" ||
      ended.request.signIn === undefined ||
      !("callId" in ended.subject) ||
      ended.subject.callId !== payload.callId
    )
      return [];
    return [{ interactionId, reason: event.data.reason ?? outcome }];
  });
}

/**
 * The other open sign-ins an acceptance or a decline in `answer` settles: for the same Connect
 * grant and principal (`sameRelayedSignIn`), asked on this deployment by this session or one of
 * its children (`localSignInCallback`). A failure is its asker's to retry, so it settles only its
 * own row, and a responder's sign-in settles only through its own approval. Any other row keeps its
 * own card.
 */
export function signInsAnswered(
  tables: SessionView,
  answer: SignInAnswer,
  own: OwnCallbacks,
): readonly AnsweredSignIn[] {
  // The provider's answer, as its redirect carries it: a decline is RFC 6749 `access_denied`.
  const params: AnsweredSignIn["params"] =
    answer.outcome === "declined" ? { error: SIGN_IN_DECLINED } : {};
  return Object.values(tables.interactions).flatMap((row) => {
    if (
      row.interactionId === answer.interactionId ||
      row.status !== "open" ||
      "responseId" in row.subject ||
      row.request.signIn === undefined ||
      !sameRelayedSignIn(row.request.signIn, answer.signIn)
    )
      return [];
    const callback = localSignInCallback(row, own);
    return callback === undefined ? [] : [{ callback, params }];
  });
}
