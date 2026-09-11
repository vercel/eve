import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  isSessionInboxAddress,
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  type SessionInboxAddress,
} from "#execution/wire/session-inbox-contract.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

export interface ResumedSessionInboxHook {
  readonly ownerRunId: string;
  readonly sessionId: string;
}

/** Resumes the current owner with the current command shape. */
export async function resumeSessionInbox(
  address: string | SessionInboxAddress,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): Promise<ResumedSessionInboxHook> {
  let token: string;
  if (typeof address === "string") {
    token = address;
  } else {
    if (!isSessionInboxAddress(address))
      throw new Error("Session inbox target has an invalid address.");
    token = sessionCommandHookToken(address.sessionId);
  }
  const hook = await getHookByToken(token);
  const metadata = await hook.metadata;
  const sessionId = readSessionId(metadata) ?? hook.runId;
  await resumeHook(hook, command);
  return { ownerRunId: hook.runId, sessionId };
}

function readSessionId(metadata: unknown): string | undefined {
  if (!isObject(metadata)) return undefined;
  const value = metadata[SESSION_INBOX_SESSION_ID_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
