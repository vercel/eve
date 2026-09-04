import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { SESSION_INBOX_WIRE_VERSION } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { resumeHook } from "#internal/workflow/runtime.js";

type ResumedSessionInboxHook = Awaited<ReturnType<typeof resumeHook>>;

/** Validates the current wire format and resumes the inbox by token. */
export async function resumeSessionInbox(
  token: string,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): Promise<ResumedSessionInboxHook> {
  return await resumeHook(
    token,
    sessionInboxWire.encode(command, { version: SESSION_INBOX_WIRE_VERSION }),
  );
}
