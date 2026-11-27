import {
  forgetInboxOwner,
  issueInboxHandle,
  recallInboxOwner,
  rememberInboxOwner,
  type InboxHook,
  type RememberedInboxOwner,
} from "#execution/session-inbox/handle.js";
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
import {
  assertRunnableSessionOwner,
  findSessionHookHolder,
  resumeRunnableHook,
  StrandedSessionOwnerError,
  strandedIfDeploymentDeleted,
} from "#execution/session-inbox/owner.js";
import { withPreV27Answers } from "#execution/session-inbox/pre-v27.js";
import { isOwnerDeploymentDeletedError } from "#internal/workflow/owner-deployment-deleted.js";
import { getHookByToken, getWorld, resumeHook, type Hook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";

export interface ResumedSessionInboxHook {
  readonly ownerRunId: string;
  readonly inbox?: string;
  readonly sessionId: Promise<string>;
  readonly startAddress?: string;
}

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
  const physicalToken = sessionInboxHookToken(token);
  const remembered = recallInboxOwner(physicalToken);
  let hook: Awaited<ReturnType<typeof resumeRunnableHook>>;
  try {
    hook = await resumeCurrentOwner(
      physicalToken,
      command,
      typeof address === "string" ? undefined : address.inbox,
      remembered?.hook,
    );
  } catch (error) {
    forgetInboxOwner(physicalToken);
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
  if (remembered !== undefined && remembered.hook.hookId !== hook.hookId)
    forgetInboxOwner(physicalToken);
  let identity: Promise<string> | undefined;
  return {
    ownerRunId: hook.runId,
    inbox: issueInboxHandle(hook),
    get sessionId() {
      return (identity ??= (async () => {
        try {
          let sessionId: string;
          if (knownSessionId !== undefined) {
            if (command.kind === "reset") await assertLiveResetOwner(hook);
            sessionId = knownSessionId;
          } else {
            sessionId =
              remembered !== undefined && remembered.hook.hookId === hook.hookId
                ? await liveSessionId(remembered)
                : requireSessionId(await hook.metadata);
          }
          rememberInboxOwner(hook, sessionId);
          return sessionId;
        } catch (cause) {
          forgetInboxOwner(physicalToken);
          if (cause instanceof StrandedSessionOwnerError) throw cause;
          const stranded = await strandedIfDeploymentDeleted(cause, hook);
          throw stranded === cause ? new AcceptedSessionIdentityError(cause) : stranded;
        }
      })());
    },
  };
}

async function assertLiveResetOwner(hook: Hook): Promise<void> {
  const world = await getWorld();
  if (world.getEncryptionKeyForRun === undefined) return;
  try {
    const deploymentId =
      hook.resumeContext?.deploymentId ??
      (await world.runs.get(hook.runId, { resolveData: "none" })).deploymentId;
    await world.getEncryptionKeyForRun(hook.runId, { deploymentId });
  } catch (cause) {
    const stranded = await strandedIfDeploymentDeleted(cause, hook);
    if (stranded !== cause) throw stranded;
  }
}

async function liveSessionId({ hook, sessionId }: RememberedInboxOwner): Promise<string> {
  const world = await getWorld();
  await world.getEncryptionKeyForRun?.(hook.runId, {
    deploymentId: hook.resumeContext?.deploymentId,
  });
  return sessionId;
}

async function resumeCurrentOwner(
  token: string,
  command: unknown,
  inbox: string | undefined,
  remembered: InboxHook | undefined,
): Promise<Awaited<ReturnType<typeof resumeRunnableHook>>> {
  try {
    return await resumeRunnableHook(token, command, inbox, remembered);
  } catch (error) {
    if (!isOwnerDeploymentDeletedError(error)) throw error;
    const holder = await findSessionHookHolder(token);
    if (holder?.hook === undefined) throw error;
    const readFailure = await holder.hook.metadata.then(
      () => undefined,
      (cause: unknown) => cause ?? error,
    );
    if (readFailure === undefined) return await resumeRunnableHook(token, command);
    const stranded = await strandedIfDeploymentDeleted(readFailure, holder.hook);
    throw stranded === readFailure ? error : stranded;
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
  const physicalToken = sessionInboxHookToken(token);
  let hook: Hook | undefined;
  try {
    hook = await getHookByToken(physicalToken);
    const sessionId = requireSessionId(await hook.metadata);
    rememberInboxOwner(hook, sessionId);
    return { sessionId };
  } catch (error) {
    if (hook !== undefined) {
      const stranded = await strandedIfDeploymentDeleted(error, hook);
      if (stranded !== error) throw stranded;
    }
    if (!HookNotFoundError.is(error)) throw error;
    forgetInboxOwner(physicalToken);
    const target = await resolveLegacyInbox(token);
    return { sessionId: target.sessionId };
  }
}

export async function resumeSessionStartHook(
  sessionId: string,
  payload: unknown,
): Promise<{ readonly address: string; readonly runId: string } | undefined> {
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
  const isReset = isObject(payload) && payload.kind === "reset";
  try {
    const resumed = await resumeHook(resumable, payload);
    if (isReset) await assertLiveResetOwner(resumed);
    return { address, runId: resumed.runId };
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    if (isReset) {
      if (error instanceof StrandedSessionOwnerError) throw error;
      const stranded = await strandedIfDeploymentDeleted(error, hook.runId);
      if (stranded !== error) throw stranded;
    }
    throw error;
  }
}

type WorldHooks = Awaited<ReturnType<typeof getWorld>>["hooks"];

function isMissingHook(error: unknown): boolean {
  return HookNotFoundError.is(error) || (WorkflowWorldError.is(error) && error.status === 404);
}

function rethrowUnsupportedAsNotFound(error: unknown): never {
  if (error instanceof UnsupportedLegacySessionError) throw new HookNotFoundError(error.message);
  throw error;
}
