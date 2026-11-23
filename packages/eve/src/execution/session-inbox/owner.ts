import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { readInboxHandle, type InboxHook } from "#execution/session-inbox/handle.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { isSessionInboxHookToken } from "#execution/session-inbox/address.js";
import {
  findRetiredOwnerRun,
  routesToOwnerDeployment,
  type OwnerRun,
} from "#execution/session-inbox/runnable-owner.js";
import { DevelopmentRunUnavailableError } from "#internal/workflow/development-run-unavailable-error.js";
import { isOwnerDeploymentDeletedError } from "#internal/workflow/owner-deployment-deleted.js";
import { getHookByToken, getWorld, resumeHook, type Hook } from "#internal/workflow/runtime.js";

export class StrandedSessionOwnerError extends Error {
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

  get eveVersion(): string | undefined {
    return this.ownerRun.attributes[EVE_VERSION_ATTRIBUTE];
  }
}

export async function resumeRunnableHook(
  token: string,
  payload: unknown,
  inbox?: string,
  remembered?: InboxHook,
): Promise<Awaited<ReturnType<typeof resumeHook>>> {
  const world = inbox !== undefined || remembered !== undefined ? await getWorld() : undefined;
  if (
    world !== undefined &&
    routesToOwnerDeployment(world) &&
    world.capabilities !== undefined &&
    "resolvedHookResume" in world.capabilities &&
    world.capabilities.resolvedHookResume === true
  ) {
    const parsed =
      inbox !== undefined && inbox.length <= 8_192 ? readInboxHandle(inbox) : undefined;
    const cached =
      parsed?.token === token ? parsed : remembered?.token === token ? remembered : undefined;
    if (cached !== undefined) {
      try {
        return await resumeHook(cached, payload);
      } catch (error) {
        if (!HookNotFoundError.is(error)) throw error;
      }
    }
  }
  if (isSessionInboxHookToken(token)) await assertRunnableSessionInbox(token);
  return await resumeHook(token, payload);
}

export async function resumeSignInCallback(
  token: string,
  payload: AuthorizationCallbackPayload,
): Promise<void> {
  try {
    await resumeRunnableHook(token, payload);
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
}

export async function assertRunnableSessionInbox(token: string): Promise<void> {
  const world = await getWorld();
  if (routesToOwnerDeployment(world)) return;
  const holder = await findSessionHookHolder(token);
  if (holder !== undefined) await assertRunnableOwner(world, holder.runId, holder.hook);
}

export async function assertRunnableSessionOwner(holder: {
  readonly runId: string;
  readonly hook?: Hook;
}): Promise<void> {
  const world = await getWorld();
  if (routesToOwnerDeployment(world)) return;
  await assertRunnableOwner(world, holder.runId, holder.hook);
}

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

export async function lookupSessionOwnerHook(token: string): Promise<Hook> {
  try {
    return await getHookByToken(token);
  } catch (error) {
    if (!DevelopmentRunUnavailableError.is(error)) throw error;
    await assertRunnableOwner(await getWorld(), error.runId);
    throw error;
  }
}

export async function strandedIfDeploymentDeleted(
  error: unknown,
  runIdOrHook: Hook | string,
): Promise<unknown> {
  if (!isOwnerDeploymentDeletedError(error)) return error;
  const runId = typeof runIdOrHook === "string" ? runIdOrHook : runIdOrHook.runId;
  const hook = typeof runIdOrHook === "string" ? undefined : runIdOrHook;
  try {
    const world = await getWorld();
    const ownerRun = await world.runs.get(runId, { resolveData: "none" });
    return new StrandedSessionOwnerError(ownerRun, hook);
  } catch {
    return error;
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
