/** Current persisted session-inbox wire version. */
export const SESSION_INBOX_WIRE_VERSION = 1;

/** Raised when a session inbox value violates its versioned wire contract. */
export class SessionInboxWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInboxWireError";
  }
}
