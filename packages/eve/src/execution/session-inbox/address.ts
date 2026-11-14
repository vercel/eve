/** Serialized-context key advertising a session's stable inbox. */
export const SESSION_INBOX_CONTEXT_KEY = "eve.sessionInbox";

/** Hook metadata key that keeps public identity separate from hook ownership. */
export const SESSION_INBOX_SESSION_ID_METADATA_KEY = "sessionId";

/** Stable inbox coordinates. The owner and deployment are intentionally absent. */
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

/** Returns whether a token belongs to eve's framework-reserved session namespace. */
export function isReservedSessionCommandToken(token: string): boolean {
  return token.startsWith("eve:session:") || token.startsWith("eve:inbox:");
}

/** Logical stable command inbox token for a session. */
export function sessionCommandHookToken(sessionId: string): string {
  return `eve:session:${sessionId}:inbox`;
}

/** The session a logical command token (`sessionCommandHookToken`) addresses. */
export function sessionIdOfCommandToken(token: string): string | undefined {
  return /^eve:session:(.+):inbox$/u.exec(token)?.[1];
}

const SESSION_INBOX_HOOK_TOKEN_PREFIX = "eve:inbox:v1:";

/**
 * Physical hook token for a logical session address. Applied exactly where a
 * hook is created or resumed, so current-generation hooks stay disjoint from
 * hooks owned by pre-cutover drivers that used the logical token directly.
 */
export function sessionInboxHookToken(token: string): string {
  return `${SESSION_INBOX_HOOK_TOKEN_PREFIX}${token}`;
}

/** Whether a physical hook token addresses a current-generation session inbox. */
export function isSessionInboxHookToken(token: string): boolean {
  return token.startsWith(SESSION_INBOX_HOOK_TOKEN_PREFIX);
}

/** Logical address behind a physical session inbox hook token; `undefined` for any other hook. */
export function logicalSessionInboxToken(token: string): string | undefined {
  return isSessionInboxHookToken(token)
    ? token.slice(SESSION_INBOX_HOOK_TOKEN_PREFIX.length)
    : undefined;
}

/** Logical token behind an address: the address itself, or the session's stable command token. */
export function logicalSessionToken(address: string | SessionInboxAddress): string {
  if (typeof address === "string") return address;
  if (!isSessionInboxAddress(address))
    throw new Error("Session inbox target has an invalid address.");
  return sessionCommandHookToken(address.sessionId);
}
