import type { DeliverHookPayload, SessionCommand } from "#channel/types.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";

/** What a losing session candidate hands to the owner: its own command, then each follow-up it accepted. */
export type ContinuationConflictPayload =
  | Extract<SessionCommand, { readonly kind: "send" }>
  | DeliverHookPayload;

/**
 * Hands one of a losing session candidate's payloads to the session that owns the continuation.
 * One step per payload, so a retry never resends a payload the owner already accepted.
 */
export async function settleContinuationConflictStep(input: {
  readonly payload: ContinuationConflictPayload;
  readonly continuationToken: string;
}): Promise<void> {
  "use step";

  await resumeSessionInbox(input.continuationToken, input.payload);
}
