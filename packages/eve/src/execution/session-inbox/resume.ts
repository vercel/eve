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
  logicalSessionInboxToken,
  logicalSessionToken,
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import { assertRunnableSessionOwner, resumeRunnableHook } from "#execution/session-inbox/owner.js";
import { withPreV27Answers } from "#execution/session-inbox/pre-v27.js";
import { getHookByToken, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

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
 * Resumes the current owner with the current command shape. A handoff never
 * leaves an address unowned: the successor force-claims the source's hooks.
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
 * id, so it never reaches a later session's claim of the same address.
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
