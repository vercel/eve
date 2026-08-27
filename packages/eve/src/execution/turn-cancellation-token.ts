/** Derives the private cancellation hook token for one dispatched turn. */
export function turnCancellationHookToken(controlToken: string): string {
  return `${controlToken}:cancel`;
}

/**
 * Payload accepted by the private turn cancel hook. A mismatched `turnId` is a
 * benign no-op; omitting it targets whichever turn owns the hook.
 */
export interface TurnCancelPayload {
  readonly turnId?: string;
}
