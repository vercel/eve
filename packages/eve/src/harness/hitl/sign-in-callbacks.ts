import { authHookToken, CallbackBaseUrlKey } from "#harness/authorization.js";
import type { Step } from "#harness/step/context.js";
import { parseEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import { vercelConnectCallbackUrl } from "#runtime/connections/scoped-authorization.js";
import { ContextKey } from "#context/key.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import type { ModelMessage } from "ai";
import type { Transition } from "#harness/session-machine/commit.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { SignInChallenge } from "#protocol/session-events/families/interaction.js";
import { SIGN_IN_DECLINED, sameRelayedSignIn, type CallsBack } from "./sign-ins.js";

export interface OwnCallbacks {
  readonly origin: string;
  readonly sessionId: string;
}

export function ownCallbacks(sessionId: string, callbackBaseUrl: string): OwnCallbacks {
  return { origin: new URL(vercelConnectCallbackUrl(callbackBaseUrl)).origin, sessionId };
}

export interface SignInCallback {
  readonly name: string;
  readonly attemptId: string;
  readonly token: string;
}

export function localSignInCallback(
  row: Pick<InteractionRow, "origin" | "request">,
  own: OwnCallbacks,
): SignInCallback | undefined {
  const callbackUrl = row.request.signIn?.callbackUrl;
  if (callbackUrl === undefined || !URL.canParse(callbackUrl)) return undefined;
  const url = new URL(callbackUrl);
  if (url.origin !== own.origin) return undefined;
  const callback = parseEveConnectionCallbackRoutePath(url.pathname);
  const asker = row.origin?.sessionId ?? own.sessionId;
  return callback?.token === authHookToken(asker) ? callback : undefined;
}

export function callsBackFor(own: OwnCallbacks): CallsBack {
  return (row) => localSignInCallback(row, own) !== undefined;
}

export type ResumeSignIn = (token: string, payload: AuthorizationCallbackPayload) => Promise<void>;

export const ResumeSignInKey = new ContextKey<ResumeSignIn>("eve.resumeSignIn");

function stepCallbacks(step: Pick<Step, "ctx" | "session">): OwnCallbacks | undefined {
  const baseUrl = step.ctx.get(CallbackBaseUrlKey);
  return baseUrl === undefined ? undefined : ownCallbacks(step.session.sessionId, baseUrl);
}

export function stepCallsBack(step: Pick<Step, "ctx" | "session">): CallsBack | undefined {
  const own = stepCallbacks(step);
  return own === undefined ? undefined : callsBackFor(own);
}

export async function applyEndingSignIns(
  step: Pick<Step, "apply" | "ctx" | "session" | "view">,
  change: Transition,
  messages?: readonly ModelMessage[],
): Promise<void> {
  const own = stepCallbacks(step);
  if (own !== undefined) {
    const tables = step.view().projection.view;
    const ended = change.events.flatMap((event) => {
      if (event.type !== "interaction.settled") return [];
      const { interactionId, outcome, reason } = event.data;
      if (outcome === "accepted" || outcome === "declined") return [];
      return signInsEnded(tables, { interactionId, reason: reason ?? outcome }, own);
    });
    if (ended.length > 0) await settleSignIns(step.ctx.require(ResumeSignInKey), ended);
  }
  await step.apply(change, messages);
}

export interface AnsweredSignIn {
  readonly callback: SignInCallback;
  readonly params: Readonly<Record<string, string>>;
}

export interface SignInEnding {
  readonly interactionId: string;
  readonly reason: string;
}

export function signInsEnded(
  tables: SessionView,
  ending: SignInEnding,
  own: OwnCallbacks,
): readonly AnsweredSignIn[] {
  return Object.values(tables.interactions).flatMap((row) => {
    if (row.status !== "open" || row.request.signIn?.waitsOn !== ending.interactionId) return [];
    const callback = localSignInCallback(row, own);
    return callback === undefined ? [] : [{ callback, params: { error: ending.reason } }];
  });
}

export async function settleSignIns(
  resume: ResumeSignIn,
  answered: readonly AnsweredSignIn[],
): Promise<void> {
  await Promise.all(
    answered.map(({ callback, params }) =>
      resume(callback.token, {
        kind: "authorization-callback",
        payloads: [
          {
            authorizationCallback: {
              attemptId: callback.attemptId,
              callback: { method: "GET", params },
              connectionName: callback.name,
            },
          },
        ],
      }),
    ),
  );
}

export interface SignInAnswer {
  readonly interactionId: string;
  readonly signIn: SignInChallenge;
  readonly outcome: "accepted" | "declined";
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
