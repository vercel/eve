import type { SessionCommand } from "#channel/types.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";

/** Hands a losing session candidate's command to the session that owns the continuation. */
export async function settleContinuationConflictStep(input: {
  readonly command: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly continuationToken: string;
}): Promise<void> {
  "use step";

  await resumeSessionInbox(input.continuationToken, input.command);
}
