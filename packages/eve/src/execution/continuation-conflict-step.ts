import type { DeliverHookPayload, SessionCommand } from "#channel/types.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";

/** What a losing session candidate hands to the owner: its own command, then each follow-up it accepted. */
export type ContinuationConflictPayload =
  | Extract<SessionCommand, { readonly kind: "send" }>
  | DeliverHookPayload;

/** Hands a losing session candidate's payloads, in order, to the session that owns the continuation. */
export async function settleContinuationConflictStep(input: {
  readonly payloads: readonly ContinuationConflictPayload[];
  readonly continuationToken: string;
}): Promise<void> {
  "use step";

  for (const payload of input.payloads) {
    await resumeSessionInbox(input.continuationToken, payload);
  }
}
