import type { Hook } from "#compiled/@workflow/core/index.js";

export async function claimHookOwnership<T>(hook: Hook<T>): Promise<void> {
  let conflict: Awaited<ReturnType<Hook<T>["getConflict"]>>;
  try {
    conflict = await hook.getConflict();
  } catch (error) {
    return await disposeAndThrow(hook, error);
  }

  if (conflict !== null) {
    return await disposeAndThrow(hook, createHookConflictError(hook.token, conflict.runId));
  }
}

export async function disposeHook(hook: { dispose: () => unknown }): Promise<void> {
  await hook.dispose();
}

async function disposeAndThrow(hook: Hook<unknown>, error: unknown): Promise<never> {
  try {
    await disposeHook(hook);
  } catch {}
  throw error;
}

export function isHookConflictError(error: unknown): error is {
  readonly conflictingRunId?: unknown;
  readonly name: "HookConflictError";
  readonly token?: unknown;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "HookConflictError"
  );
}

export function isHookForceClaimedError(error: unknown): error is {
  readonly claimedByRunId: string;
  readonly name: "HookForceClaimedError";
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "HookForceClaimedError" &&
    "claimedByRunId" in error &&
    typeof error.claimedByRunId === "string"
  );
}

function createHookConflictError(
  token: string,
  conflictingRunId: string,
): Error & {
  readonly conflictingRunId: string;
  readonly token: string;
} {
  const owner = ` (run "${conflictingRunId}")`;
  return Object.assign(new Error(`Hook token "${token}" is already in use${owner}`), {
    conflictingRunId,
    name: "HookConflictError",
    token,
  });
}
