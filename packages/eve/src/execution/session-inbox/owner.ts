import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { isSessionInboxHookToken } from "#execution/session-inbox/address.js";
import {
  findRetiredOwnerRun,
  routesToOwnerDeployment,
  type OwnerRun,
} from "#execution/session-inbox/runnable-owner.js";
import { DevelopmentRunUnavailableError } from "#internal/workflow/development-run-unavailable-error.js";
import { getHookByToken, getWorld, resumeHook, type Hook } from "#internal/workflow/runtime.js";

/**
 * The session's owner was built by another eve version, so this build cannot
 * execute it and ingress refused the command before committing it. Internal:
 * carries the owner run, which never reaches a client.
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
 * cannot execute before anything is committed, then resumes by token. Any
 * other hook resumes unchecked. Resuming by token rather than by the looked-up
 * hook keeps Workflow's delivery dedup, which a caller-supplied hook disables.
 */
export async function resumeRunnableHook(
  token: string,
  payload: unknown,
): Promise<Awaited<ReturnType<typeof resumeHook>>> {
  if (isSessionInboxHookToken(token)) await assertRunnableSessionInbox(token);
  return await resumeHook(token, payload);
}

/**
 * Throws {@link StrandedSessionOwnerError} when the run holding a physical
 * session inbox token cannot execute. An unheld token passes: resuming it
 * reports the absence. Where the World replays each run on its own
 * deployment, every owner can execute, so nothing is looked up.
 */
export async function assertRunnableSessionInbox(token: string): Promise<void> {
  const world = await getWorld();
  if (routesToOwnerDeployment(world)) return;
  const holder = await findSessionHookHolder(token);
  if (holder !== undefined) await assertRunnableOwner(world, holder.runId, holder.hook);
}

/** {@link assertRunnableSessionInbox} for a hook the caller already looked up. */
export async function assertRunnableSessionOwner(hook: Hook): Promise<void> {
  const world = await getWorld();
  if (routesToOwnerDeployment(world)) return;
  await assertRunnableOwner(world, hook.runId, hook);
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
    await assertRunnableOwner(await getWorld(), error.runId);
    throw error;
  }
}

async function assertRunnableOwner(
  world: Awaited<ReturnType<typeof getWorld>>,
  runId: string,
  hook?: Hook,
): Promise<void> {
  const ownerRun = await findRetiredOwnerRun(world, runId);
  if (ownerRun !== undefined) throw new StrandedSessionOwnerError(ownerRun, hook);
}
