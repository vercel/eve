import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import {
  resolveLegacyInbox,
  resumeLegacyInbox,
  UnsupportedLegacySessionError,
} from "#execution/legacy-session/inbox.js";
import {
  isSessionInboxAddress,
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  sessionCommandHookToken,
  sessionHandoffMarkerToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import type { TaskDeadlineSignal } from "#tasks/protocol.js";
import { isObject } from "#shared/guards.js";

/** Longest a delivery waits for a mid-handoff successor to claim its hooks. */
const HANDOFF_RETRY_WINDOW_MS = 5_000;
const HANDOFF_RETRY_INTERVAL_MS = 20;

export interface ResumedSessionInboxHook {
  readonly ownerRunId: string;
  /** Lazy identity resolution; delivery never needs to decrypt hook metadata. */
  readonly sessionId: Promise<string>;
}

/**
 * Resumes the current owner with the current command shape. During a
 * deployment handoff the address is briefly unowned; the releasing owner
 * leaves a marker for that interval, so delivery retries instead of
 * reporting the session gone and letting a channel start a replacement.
 */
export async function resumeSessionInbox(
  address: string | SessionInboxAddress,
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload | TaskDeadlineSignal,
): Promise<ResumedSessionInboxHook> {
  const token = logicalToken(address);
  const deadline = Date.now() + HANDOFF_RETRY_WINDOW_MS;
  while (true) {
    let hook;
    try {
      hook = await resumeHook(sessionInboxHookToken(token), command);
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      if (await isHandoffInProgress(token, deadline)) continue;
      return await resumeLegacyInbox(token, command).catch(rethrowUnsupportedAsNotFound);
    }
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

export async function resolveSessionInbox(token: string): Promise<{ sessionId: string }> {
  try {
    const hook = await getHookByToken(sessionInboxHookToken(token));
    return { sessionId: requireSessionId(await hook.metadata) };
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
    const target = await resolveLegacyInbox(token);
    return { sessionId: target.sessionId };
  }
}

/** A driver too old to import is, for every caller, a session that no longer exists. */
function rethrowUnsupportedAsNotFound(error: unknown): never {
  if (error instanceof UnsupportedLegacySessionError) throw new HookNotFoundError(error.message);
  throw error;
}

function logicalToken(address: string | SessionInboxAddress): string {
  if (typeof address === "string") return address;
  if (!isSessionInboxAddress(address))
    throw new Error("Session inbox target has an invalid address.");
  return sessionCommandHookToken(address.sessionId);
}

/** Waits one retry interval when a handoff marker exists; false once the window closes or no marker exists. */
async function isHandoffInProgress(token: string, deadline: number): Promise<boolean> {
  if (Date.now() >= deadline) return false;
  try {
    await getHookByToken(sessionHandoffMarkerToken(token));
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, HANDOFF_RETRY_INTERVAL_MS));
  return true;
}
