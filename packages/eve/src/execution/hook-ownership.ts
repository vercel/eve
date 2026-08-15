import type { Hook } from "#compiled/@workflow/core/index.js";

export async function claimHookOwnership<T>(hook: Hook<T>): Promise<void> {
  let conflict: Awaited<ReturnType<Hook<T>["getConflict"]>>;
  try {
    conflict = await hook.getConflict();
  } catch (error) {
    return await disposeAndThrow(hook, normalizeHookClaimError(error, hook.token));
  }

  if (conflict !== null) {
    return await disposeAndThrow(hook, createHookConflictError(hook.token, conflict.runId));
  }
}

export async function closeHookIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  if (typeof iterator.return === "function") {
    await iterator.return(undefined);
  }
}

export async function disposeHook(hook: {
  dispose?: () => unknown;
  [Symbol.dispose]?: () => unknown;
}): Promise<void> {
  const explicitDispose = hook.dispose;
  if (typeof explicitDispose === "function") {
    await explicitDispose.call(hook);
    return;
  }

  const symbolDispose = hook[Symbol.dispose];
  if (typeof symbolDispose === "function") {
    await symbolDispose.call(hook);
  }
}

async function disposeAndThrow(hook: Hook<unknown>, error: unknown): Promise<never> {
  try {
    await disposeHook(hook);
  } catch {
    // The claim failure is authoritative; cleanup must not replace it.
  }
  throw error;
}

function normalizeHookClaimError(error: unknown, token: string): unknown {
  if (!isHookConflictError(error)) {
    return error;
  }

  // Legacy worlds reject here when they cannot identify the owning run.
  return createHookConflictError(
    typeof error.token === "string" ? error.token : token,
    typeof error.conflictingRunId === "string" ? error.conflictingRunId : undefined,
  );
}

/** Recognizes hook conflicts across current and legacy Workflow World implementations. */
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

function createHookConflictError(
  token: string,
  conflictingRunId?: string,
): Error & {
  readonly conflictingRunId?: string;
  readonly token: string;
} {
  const owner = conflictingRunId === undefined ? "" : ` (run "${conflictingRunId}")`;
  return Object.assign(new Error(`Hook token "${token}" is already in use${owner}`), {
    conflictingRunId,
    name: "HookConflictError",
    token,
  });
}
