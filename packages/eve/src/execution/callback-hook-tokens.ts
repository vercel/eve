import {
  isSessionCommandHookToken,
  logicalSessionInboxToken,
} from "#execution/session-inbox/address.js";

const REMOTE_REPLY_PREFIX = "eve:reply:v1:";
const SIGN_IN_PREFIX = "eve:sign-in:v1:";

export function remoteReplyHookToken(id: string): string {
  return `${REMOTE_REPLY_PREFIX}${id}`;
}

export function isRemoteReplyHookToken(token: string): boolean {
  return token.startsWith(REMOTE_REPLY_PREFIX);
}

export function signInHookToken(id: string): string {
  return `${SIGN_IN_PREFIX}${id}`;
}

export function isSignInCallbackToken(token: string): boolean {
  const inbox = logicalSessionInboxToken(token);
  return inbox === undefined ? token.startsWith(SIGN_IN_PREFIX) : isSessionCommandHookToken(inbox);
}
