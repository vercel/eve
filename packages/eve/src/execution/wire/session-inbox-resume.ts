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
import { resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

export interface ResumedSessionInboxHook {
  readonly ownerRunId: string;
  /** Lazy identity resolution; delivery never needs to decrypt hook metadata. */
  readonly sessionId: Promise<string>;
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
  const hook = await resumeHook(token, command);
  let identity: Promise<string> | undefined;
  return {
    ownerRunId: hook.runId,
    get sessionId() {
      return (identity ??= (async () => {
        try {
          return typeof address === "string"
            ? requireSessionId(await hook.metadata)
            : address.sessionId;
        } catch (cause) {
          // A failed identity read must never cause a second delivery.
          throw new AcceptedSessionIdentityError(cause);
        }
      })());
    },
  };
}

export class AcceptedSessionIdentityError extends Error {
  constructor(cause: unknown) {
    super("Session command accepted, but its session identity could not be resolved.", { cause });
    this.name = "AcceptedSessionIdentityError";
  }
}

export function requireSessionId(metadata: unknown): string {
  const value = isObject(metadata) ? metadata[SESSION_INBOX_SESSION_ID_METADATA_KEY] : undefined;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Session hook metadata is missing its session ID.");
  return value;
}
