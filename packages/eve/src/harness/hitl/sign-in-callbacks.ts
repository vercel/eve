import { authHookToken, CallbackBaseUrlKey } from "#harness/authorization.js";
import type { Step } from "#harness/step/context.js";
import { parseEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import { vercelConnectCallbackUrl } from "#runtime/connections/scoped-authorization.js";
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

/** The sign-ins `step`'s session can call back, when it runs in a workflow. */
export function stepCallsBack(step: Pick<Step, "ctx" | "session">): CallsBack | undefined {
  const baseUrl = step.ctx.get(CallbackBaseUrlKey);
  return baseUrl === undefined
    ? undefined
    : callsBackFor(ownCallbacks(step.session.sessionId, baseUrl));
}
