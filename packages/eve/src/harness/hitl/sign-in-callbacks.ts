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
import type { CallsBack } from "./sign-ins.js";

// Which sign-in callbacks this session can call. Not for workflow bodies: it reads the step's
// context and the connection runtime.

/** Where this session's own sign-in callbacks point: its deployment's origin and its own session. */
export interface OwnCallbacks {
  readonly origin: string;
  readonly sessionId: string;
}

/**
 * This session's own callbacks, at its workflow's callback base URL. Only a Vercel Connect sign-in
 * has a grant to share, and its callback names a loopback host `localhost`, as `eve dev` mints it.
 */
export function ownCallbacks(sessionId: string, callbackBaseUrl: string): OwnCallbacks {
  return { origin: new URL(vercelConnectCallbackUrl(callbackBaseUrl)).origin, sessionId };
}

/** A sign-in's callback, as its asker's inbox reads it. */
export interface SignInCallback {
  readonly name: string;
  readonly attemptId: string;
  readonly token: string;
}

/**
 * The callback of a sign-in asked on this deployment, by this session or a child session it
 * runs: its URL is on this deployment's origin and names the asker's inbox. A remote child's
 * callback belongs to its own deployment's world, and the parent never resumes a hook a child's
 * URL merely names.
 */
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

/** Whether this session can call a sign-in's callback (`localSignInCallback`). */
export function callsBackFor(own: OwnCallbacks): CallsBack {
  return (row) => localSignInCallback(row, own) !== undefined;
}

/** Delivers a sign-in callback to its asker's inbox. */
export type ResumeSignIn = (token: string, payload: AuthorizationCallbackPayload) => Promise<void>;

/** How this step delivers sign-in callbacks; the workflow step that runs the turn sets it. */
export const ResumeSignInKey = new ContextKey<ResumeSignIn>("eve.resumeSignIn");

/** `step`'s session's own callbacks, when it runs in a workflow. */
function stepCallbacks(step: Pick<Step, "ctx" | "session">): OwnCallbacks | undefined {
  const baseUrl = step.ctx.get(CallbackBaseUrlKey);
  return baseUrl === undefined ? undefined : ownCallbacks(step.session.sessionId, baseUrl);
}

/** The sign-ins `step`'s session can call back, when it runs in a workflow. */
export function stepCallsBack(step: Pick<Step, "ctx" | "session">): CallsBack | undefined {
  const own = stepCallbacks(step);
  return own === undefined ? undefined : callsBackFor(own);
}

/**
 * Applies a transition that can end this session's own sign-in cards without an answer, as a
 * newer attempt replaces them. The sign-ins that waited on such a card hear first that it ended
 * (`signInsEnded`), so none waits on a card nobody sees.
 */
export async function applyEndingSignIns(
  step: Pick<Step, "apply" | "ctx" | "session" | "view">,
  change: Transition,
  messages?: readonly ModelMessage[],
): Promise<void> {
  const own = stepCallbacks(step);
  if (own !== undefined) {
    const ended = signInsEndedBy(step.view().projection.view, change, own);
    if (ended.length > 0) await settleSignIns(step.ctx.require(ResumeSignInKey), ended);
  }
  await step.apply(change, messages);
}

/** The open sign-ins that wait on a card `change` ends without an answer (`signInsEnded`). */
export function signInsEndedBy(
  tables: SessionView,
  change: Transition,
  own: OwnCallbacks,
): readonly AnsweredSignIn[] {
  return change.events.flatMap((event) => {
    if (event.type !== "interaction.settled") return [];
    const { interactionId, outcome, reason } = event.data;
    if (outcome === "accepted" || outcome === "declined") return [];
    return signInsEnded(tables, { interactionId, reason: reason ?? outcome }, own);
  });
}

/** An open sign-in to settle with the answer another sign-in for the same grant got. */
export interface AnsweredSignIn {
  readonly callback: SignInCallback;
  readonly params: Readonly<Record<string, string>>;
}

/** A sign-in whose card ended without an answer, and how it ended. */
export interface SignInEnding {
  readonly interactionId: string;
  readonly reason: string;
}

/**
 * The open sign-ins that waited on `ending`'s card (`waitsOn`): no card was shown for them, so
 * they fail with it, as their own card's failure would, and their askers may ask again.
 */
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

/**
 * Calls each sign-in's callback, as Connect calls the answered one's: its asker matches the
 * attempt in its own turn and settles it under its own principal, reading what Connect holds for
 * it after an acceptance. The params carry only the answer, never a code or a credential.
 */
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
