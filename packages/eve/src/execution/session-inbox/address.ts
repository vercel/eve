/** Serialized-context key advertising a session's stable inbox. */
export const SESSION_INBOX_CONTEXT_KEY = "eve.sessionInbox";

/** Hook metadata key that keeps public identity separate from hook ownership. */
export const SESSION_INBOX_SESSION_ID_METADATA_KEY = "sessionId";

/** Stable inbox coordinates. The owner and deployment are intentionally absent. */
export interface SessionInboxAddress {
  readonly sessionId: string;
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

/**
 * Physical hook token for a logical session address. Applied exactly where a
 * hook is created or resumed, so current-generation hooks stay disjoint from
 * hooks owned by pre-cutover drivers that used the logical token directly.
 */
export function sessionInboxHookToken(token: string): string {
  return `eve:inbox:v1:${token}`;
}

/** Marker a releasing owner leaves so ingress can tell "handoff in progress" from "no session". */
export function sessionHandoffMarkerToken(token: string): string {
  return `eve:inbox:handoff:${token}`;
}
