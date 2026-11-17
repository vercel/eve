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
import { readHitlState } from "#harness/hitl/index.js";
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
import { relay, relayedMirror } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { resumeSignInCallback } from "#execution/session-inbox/owner.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

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

export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentInteractionHookPayload;
  },
): Promise<PublishedSessionEvents> {
  const { hookPayload, runId, workflowAsk } = input;
  const baseUrl = await workflowCallbackBaseUrl();
  const own =
    baseUrl === undefined ? undefined : ownCallbacks(input.durableSession.sessionId, baseUrl);
  if (own !== undefined) {
    const tables = storedProjection(input.durableSession.state).view;
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

export interface SignInAnswer {
  readonly interactionId: string;
  readonly signIn: SignInChallenge;
  readonly outcome: "accepted" | "declined";
}

async function workflowCallbackBaseUrl(): Promise<string | undefined> {
  const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
  const url = getWorkflowMetadata().url;
  return typeof url === "string" ? resolveWorkflowCallbackBaseUrl(url) : undefined;
}

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

export function signInsAnswered(
  tables: SessionView,
  answer: SignInAnswer,
  own: OwnCallbacks,
): readonly AnsweredSignIn[] {
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
