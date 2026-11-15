import {
  isSessionCommandHookToken,
  logicalSessionInboxToken,
} from "#execution/session-inbox/address.js";

// The hooks eve's two unauthenticated callback routes resume. Each route takes a hook token from
// its URL, so the token's shape is all that says the route may deliver to the hook. Authored code
// is told to keep `createHook()` tokens out of the `eve:` prefix (docs/tools/workflows.mdx);
// nothing enforces that.

const REMOTE_REPLY_PREFIX = "eve:reply:v1:";
const SIGN_IN_PREFIX = "eve:sign-in:v1:";

/**
 * Names the hook a remote agent's reply arrives on. The agent holds nothing else that says a
 * reply is its own, so `id` must be a value nobody else can compute.
 */
export function remoteReplyHookToken(id: string): string {
  return `${REMOTE_REPLY_PREFIX}${id}`;
}

/** Whether `token` names a hook a remote agent's reply arrives on. */
export function isRemoteReplyHookToken(token: string): boolean {
  return token.startsWith(REMOTE_REPLY_PREFIX);
}

/**
 * Names a hook a run opens for its own sign-in callbacks, apart from its session's inbox. The
 * token only addresses the hook: a callback's attempt id says which sign-in it answers.
 */
export function signInHookToken(id: string): string {
  return `${SIGN_IN_PREFIX}${id}`;
}

/**
 * Whether `token` names a hook that takes sign-in callbacks: a run's own sign-in hook, or a
 * session's stable inbox, which `authHookToken` names. That inbox takes every command for its
 * session; the callback route sends it nothing but a sign-in callback.
 */
export function isSignInCallbackToken(token: string): boolean {
  const inbox = logicalSessionInboxToken(token);
  return inbox === undefined ? token.startsWith(SIGN_IN_PREFIX) : isSessionCommandHookToken(inbox);
}
