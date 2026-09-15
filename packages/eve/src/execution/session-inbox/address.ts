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

/** Physical addresses are disjoint from hooks owned by pre-cutover drivers. */
export function sessionInboxHookToken(token: string): string {
  return token.startsWith("eve:inbox:v1:") ? token : `eve:inbox:v1:${token}`;
}
