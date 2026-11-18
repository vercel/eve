export const SESSION_INBOX_CONTEXT_KEY = "eve.sessionInbox";

export const SESSION_INBOX_SESSION_ID_METADATA_KEY = "sessionId";

export interface SessionInboxAddress {
  readonly sessionId: string;
  readonly inbox?: string;
}

export function isSessionInboxAddress(value: unknown): value is SessionInboxAddress {
  return (
    value !== null &&
    typeof value === "object" &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    !value.sessionId.includes(":")
  );
}

export function isReservedSessionCommandToken(token: string): boolean {
  return token.startsWith("eve:session:") || token.startsWith("eve:inbox:");
}

export function sessionCommandHookToken(sessionId: string): string {
  return `eve:session:${sessionId}:inbox`;
}

export function isSessionCommandHookToken(token: string): boolean {
  return /^eve:session:[^:]+:inbox$/.test(token);
}

const SESSION_INBOX_HOOK_TOKEN_PREFIX = "eve:inbox:v1:";

export function sessionInboxHookToken(token: string): string {
  return `${SESSION_INBOX_HOOK_TOKEN_PREFIX}${token}`;
}

export function isSessionInboxHookToken(token: string): boolean {
  return token.startsWith(SESSION_INBOX_HOOK_TOKEN_PREFIX);
}

export function logicalSessionInboxToken(token: string): string | undefined {
  return isSessionInboxHookToken(token)
    ? token.slice(SESSION_INBOX_HOOK_TOKEN_PREFIX.length)
    : undefined;
}

export function logicalSessionToken(address: string | SessionInboxAddress): string {
  if (typeof address === "string") return address;
  if (!isSessionInboxAddress(address))
    throw new Error("Session inbox target has an invalid address.");
  return sessionCommandHookToken(address.sessionId);
}
