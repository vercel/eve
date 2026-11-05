import { issueInboxHandle } from "#execution/session-inbox/handle.js";
import type { SessionPrewarmPayload } from "#execution/session-prewarm.js";
import type { SessionFailurePayload } from "#execution/session-inbox/inbox.js";
import { HookNotFoundError, WorkflowWorldError } from "#compiled/@workflow/errors/index.js";
import { startHookId } from "#compiled/@workflow/world/index.js";
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
  logicalSessionInboxToken,
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  sessionCommandHookToken,
  sessionHandoffMarkerToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import {
  assertRunnableSessionOwner,
  lookupSessionOwnerHook,
  resumeRunnableHook,
} from "#execution/session-inbox/owner.js";
import { withPreV27Answers } from "#execution/session-inbox/pre-v27.js";
import { getHookByToken, getWorld, resumeHook, type Hook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

/** Longest a delivery waits for a mid-handoff successor to claim its hooks. */
const HANDOFF_RETRY_WINDOW_MS = 5_000;
const HANDOFF_RETRY_INTERVAL_MS = 20;

export interface ResumedSessionInboxHook {
  readonly ownerRunId: string;
  readonly inbox?: string;
  /** Lazy identity resolution; delivery never needs to decrypt hook metadata. */
  readonly sessionId: Promise<string>;
  /**
   * The logical address that took the command when the session had not yet
   * claimed its stable inbox; see {@link resumeSessionStartHook}.
   */
  readonly startAddress?: string;
}

/**
 * Resumes the current owner with the current command shape. Owners on
 * handoff version 3 never leave an address unowned. An older owner releases
 * its hooks before its successor claims them and leaves a marker for that
 * interval, so delivery retries instead of
 * reporting the session gone and letting a channel start a replacement.
 * The retry window bounds this request, not the handoff: a marker that
 * outlives it throws {@link SessionHandoffPendingError}.
 */
export async function resumeSessionInbox(
  address: string | SessionInboxAddress,
  command:
    | DeliverHookPayload
    | SessionCommand
    | SessionTimeoutHookPayload
    | SessionFailurePayload
    | SessionPrewarmPayload,
): Promise<ResumedSessionInboxHook> {
  command = withPreV27Answers(command);
  const token = logicalSessionToken(address);
  const knownSessionId = typeof address === "string" ? undefined : address.sessionId;
  const deadline = Date.now() + HANDOFF_RETRY_WINDOW_MS;
  while (true) {
    let hook: Awaited<ReturnType<typeof resumeRunnableHook>>;
    try {
      hook = await resumeRunnableHook(
        sessionInboxHookToken(token),
        command,
        typeof address === "string" ? undefined : address.inbox,
      );
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      if (knownSessionId !== undefined) {
        const started = await resumeSessionStartHook(knownSessionId, command);
        if (started !== undefined) {
          return {
            ownerRunId: started.runId,
            sessionId: Promise.resolve(knownSessionId),
            startAddress: started.address,
          };
        }
      }
      if (await waitWhileHandoffInProgress(token, deadline)) continue;
      if (command.kind === "session-failure" || command.kind === "session-prewarm") throw error;
      return await resumeLegacyInbox(token, command).catch(rethrowUnsupportedAsNotFound);
    }
    let identity: Promise<string> | undefined;
    return {
      ownerRunId: hook.runId,
      inbox: issueInboxHandle(hook),
      get sessionId() {
        return (identity ??= (async () => {
          try {
            return knownSessionId ?? requireSessionId(await hook.metadata);
          } catch (cause) {
            // A failed identity read must never cause a second delivery.
            throw new AcceptedSessionIdentityError(cause);
          }
        })());
      },
    };
  }
}

/**
 * The address's owner is still handing off after the request's retry window.
 * Nothing was delivered. The address is not unowned, so callers must not start
 * a session there; the request can be retried.
 */
export class SessionHandoffPendingError extends Error {
  constructor(token: string) {
    super(
      `Session address "${token}" is still changing owners. Nothing was delivered; retry the request.`,
    );
    this.name = "SessionHandoffPendingError";
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

/**
 * Resumes the hook a session's `start()` claimed with its run. The run takes
 * commands there before it boots and claims its stable inbox, so a command
 * by session id needs no wait for the boot. Resolves `undefined` when the
 * session was started without one or has released it. The hook is resumed by
 * id, which reaches it or a handoff successor's takeover of it, never a later
 * session's claim of the same address.
 */
export async function resumeSessionStartHook(
  sessionId: string,
  payload: unknown,
): Promise<{ readonly address: string; readonly runId: string } | undefined> {
  // Only a run id names a start Hook; a caller can send any session id.
  if (!sessionId.startsWith("wrun_")) return undefined;
  let hook: Awaited<ReturnType<WorldHooks["get"]>>;
  try {
    hook = await (await getWorld()).hooks.get(startHookId(sessionId), { resolveData: "none" });
  } catch (error) {
    if (isMissingHook(error)) return undefined;
    throw error;
  }
  const address = logicalSessionInboxToken(hook.token);
  if (hook.runId !== sessionId || address === undefined) return undefined;
  await assertRunnableSessionOwner({ runId: hook.runId });
  const { metadata: _metadata, ...resumable } = hook;
  try {
    const resumed = await resumeHook(resumable, payload);
    return { address, runId: resumed.runId };
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
}

type WorldHooks = Awaited<ReturnType<typeof getWorld>>["hooks"];

/** world-vercel answers a lookup of an absent hook by id with a bare 404. */
function isMissingHook(error: unknown): boolean {
  return HookNotFoundError.is(error) || (WorkflowWorldError.is(error) && error.status === 404);
}

/** A driver too old to import is, for every caller, a session that no longer exists. */
function rethrowUnsupportedAsNotFound(error: unknown): never {
  if (error instanceof UnsupportedLegacySessionError) throw new HookNotFoundError(error.message);
  throw error;
}

/** Logical token behind an address: the address itself, or the session's stable command token. */
export function logicalSessionToken(address: string | SessionInboxAddress): string {
  if (typeof address === "string") return address;
  if (!isSessionInboxAddress(address))
    throw new Error("Session inbox target has an invalid address.");
  return sessionCommandHookToken(address.sessionId);
}

/**
 * Waits one retry interval when a handoff marker exists; false when no marker
 * exists. Throws once the window closes with the marker still in place.
 */
async function waitWhileHandoffInProgress(token: string, deadline: number): Promise<boolean> {
  let marker: Hook;
  try {
    marker = await lookupSessionOwnerHook(sessionHandoffMarkerToken(token));
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
  if (Date.now() >= deadline) {
    // A releasing owner that cannot execute never finishes its handoff.
    await assertRunnableSessionOwner({ hook: marker, runId: marker.runId });
    throw new SessionHandoffPendingError(token);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, HANDOFF_RETRY_INTERVAL_MS));
  return true;
}
