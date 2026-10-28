import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { readInboxHandle } from "#execution/session-inbox/handle.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { isSessionInboxHookToken } from "#execution/session-inbox/address.js";
import {
  findStrandedOwnerRun,
  routesToOwnerDeployment,
  type OwnerRun,
} from "#execution/session-inbox/runnable-owner.js";
import { DevelopmentRunUnavailableError } from "#internal/workflow/development-run-unavailable-error.js";
import { getHookByToken, getWorld, resumeHook, type Hook } from "#internal/workflow/runtime.js";

/**
 * Nothing can execute the session's owner: another eve version built it, or
 * the deployment it is pinned to was deleted. Ingress refused the command
 * before committing it. Internal: carries the owner run, which never reaches
 * a client.
 */
export class StrandedSessionOwnerError extends Error {
  /** The owner's hook, when ingress looked it up; its metadata names the session. */
  readonly hook: Hook | undefined;
  readonly ownerRun: OwnerRun;

  constructor(ownerRun: OwnerRun, hook?: Hook) {
    super(`Session owner run "${ownerRun.runId}" is stranded.`);
    this.name = "StrandedSessionOwnerError";
    this.hook = hook;
    this.ownerRun = ownerRun;
  }

  get ownerRunId(): string {
    return this.ownerRun.runId;
  }

  /** eve version that built the owner, when it recorded one. */
  get eveVersion(): string | undefined {
    return this.ownerRun.attributes[EVE_VERSION_ATTRIBUTE];
  }
}

/**
 * The single ingress path into a hook: refuses a session inbox whose owner
 * cannot execute before anything is committed. Vercel can reuse a validated
 * inbox handle: Workflow requires its guarded, deduplicated write endpoint.
 * Only a definite refusal falls back to resolving the current token owner.
 */
export async function resumeRunnableHook(
  token: string,
  payload: unknown,
  inbox?: string,
): Promise<Awaited<ReturnType<typeof resumeHook>>> {
  if (isSessionInboxHookToken(token)) await assertRunnableSessionInbox(token);
  const world = inbox !== undefined ? await getWorld() : undefined;
  if (
    inbox !== undefined &&
    inbox.length <= 8_192 &&
    world !== undefined &&
    routesToOwnerDeployment(world) &&
    world.capabilities !== undefined &&
    "resolvedHookResume" in world.capabilities &&
    world.capabilities.resolvedHookResume === true
  ) {
    const parsed = readInboxHandle(inbox);
    const cached = parsed?.token === token ? parsed : undefined;
    if (cached !== undefined) {
      try {
        return await resumeHook(cached, payload);
      } catch (error) {
        // Only a definite refusal may be retried against a freshly resolved owner.
        if (!HookNotFoundError.is(error)) throw error;
      }
    }
  }
  return await resumeHook(token, payload);
}

/**
 * Throws {@link StrandedSessionOwnerError} when the run holding a physical
 * session inbox token cannot execute. An unheld token passes: resuming it
 * reports the absence.
 */
export async function assertRunnableSessionInbox(token: string): Promise<void> {
  const holder = await findSessionHookHolder(token);
  if (holder !== undefined) await assertRunnableOwner(holder.runId, holder.hook);
}

/** {@link assertRunnableSessionInbox} for a holder the caller already looked up. */
export async function assertRunnableSessionOwner(holder: {
  readonly runId: string;
  readonly hook?: Hook;
}): Promise<void> {
  await assertRunnableOwner(holder.runId, holder.hook);
}

/**
 * The run holding a session hook token, or `undefined` when none does. The
 * `eve dev` World refuses to expose the hooks of a run it will not execute
 * (a dormant or ineligible generation) and names only the run, so `hook` is
 * then absent. This is the only place that refusal is interpreted.
 */
export async function findSessionHookHolder(
  token: string,
): Promise<{ readonly runId: string; readonly hook?: Hook } | undefined> {
  try {
    const hook = await getHookByToken(token);
    return { hook, runId: hook.runId };
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    if (DevelopmentRunUnavailableError.is(error)) return { runId: error.runId };
    throw error;
  }
}

/**
 * Looks up a session hook. A run the `eve dev` World refuses to expose is
 * stranded only when another eve version built it; otherwise a restart with
 * `--resume` may run it, so the refusal propagates and nothing is ended.
 */
export async function lookupSessionOwnerHook(token: string): Promise<Hook> {
  try {
    return await getHookByToken(token);
  } catch (error) {
    if (!DevelopmentRunUnavailableError.is(error)) throw error;
    await assertRunnableOwner(error.runId);
    throw error;
  }
}

async function assertRunnableOwner(runId: string, hook?: Hook): Promise<void> {
  const ownerRun = await findStrandedOwnerRun(await getWorld(), runId);
  if (ownerRun !== undefined) throw new StrandedSessionOwnerError(ownerRun, hook);
}
