/** The provider no longer retains this exact session's history. Transient read failures use their original errors. */
export class SessionHistoryUnavailableError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `History for session ${JSON.stringify(sessionId)} is no longer available. Preserve its admission as unresolved; do not resend it to a replacement session.`,
    );
    this.sessionId = sessionId;
    this.name = "SessionHistoryUnavailableError";
  }
}
