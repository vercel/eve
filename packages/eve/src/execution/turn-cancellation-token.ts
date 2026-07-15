/**
 * Session-scoped turn-cancellation hook addressing, shared by the
 * workflow-side control (which claims the hook each turn) and
 * runtime-side triggers (which resume it). Kept as a leaf module so
 * route handlers can derive the token without importing workflow-VM
 * modules.
 */

/**
 * Derives the session-scoped cancel hook token. Stable for the session's
 * lifetime, so a cancel trigger can address it from the session id alone.
 */
export function sessionCancelHookToken(sessionId: string): string {
  return `${sessionId}:cancel`;
}

/**
 * Payload accepted by the session cancel hook. The optional `turnId`
 * guard scopes the cancel to the turn the caller observed; a mismatch is
 * consumed as a benign no-op. Omitting it cancels the current turn.
 */
export interface TurnCancelPayload {
  readonly turnId?: string;
}
