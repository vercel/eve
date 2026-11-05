import { walkCauseChain } from "#shared/errors.js";

/**
 * Errors about hooks, runs and steps that code on any host raises and reads without importing
 * Workflow. Workflow's own checks (`X.is(error)`) recognize an error by its `name` on an object
 * with a `message`, so each error here carries Workflow's name: an error raised here and one
 * Workflow raised match each other's checks, also after crossing a serializer, and a report of
 * one names it as before. Checks that answer what callers ask (is the run gone, inactive, ...)
 * walk the cause chain; single-name checks don't.
 */

/** No hook holds `token`, on any host. */
export class HookNotFoundError extends Error {
  override readonly name = "HookNotFoundError";
  readonly token: string;

  constructor(token: string) {
    super("Hook not found");
    this.token = token;
  }
}

/** No host holds the run `runId`: Workflow's `WorkflowRunNotFoundError`, by its name. */
export class RunNotFoundError extends Error {
  override readonly name = "WorkflowRunNotFoundError";
  readonly runId: string;

  constructor(runId: string) {
    super(`Run "${runId}" not found`);
    this.runId = runId;
  }
}

/**
 * A step error no durable host retries. Workflow's `FatalError.is(error)` accepts it by its
 * name and its `fatal` marker, so a step that throws it fails without retries on Workflow, as one
 * that threw Workflow's `FatalError` does. An in-process host never retries a step.
 */
export class NonRetryableError extends Error {
  override readonly name = "FatalError";
  /** Workflow's marker for an error its steps don't retry. */
  readonly fatal = true;
}

type RunErrorName =
  | "EntityConflictError"
  | "HookConflictError"
  | "HookNotFoundError"
  | "RunExpiredError"
  | "StreamExpiredError"
  | "WorkflowRunNotFoundError";

function hasName(error: unknown, name: RunErrorName): boolean {
  return typeof error === "object" && error !== null && "message" in error && "name" in error
    ? error.name === name
    : false;
}

function anyCause(error: unknown, names: readonly RunErrorName[]): boolean {
  for (const cause of walkCauseChain(error))
    if (names.some((name) => hasName(cause, name))) return true;
  return false;
}

/** No hook holds the token. */
export function isHookNotFound(error: unknown): boolean {
  return hasName(error, "HookNotFoundError");
}

/** Another run holds the hook token. */
export function isHookConflict(error: unknown): boolean {
  return hasName(error, "HookConflictError");
}

/** The run doesn't exist (yet: one `start()` accepted may not be readable). */
/** A World refused to create what it already holds, such as a second `run_created` for one run. */
export function isEntityConflict(error: unknown): boolean {
  return anyCause(error, ["EntityConflictError"]);
}

export function isRunNotFound(error: unknown): boolean {
  return anyCause(error, ["WorkflowRunNotFoundError"]);
}

/** The run's data passed the World's retention; retrying can't bring it back. */
export function isRunExpired(error: unknown): boolean {
  return anyCause(error, ["RunExpiredError", "StreamExpiredError"]);
}

/** The run doesn't exist, or its history has expired. */
export function isRunMissing(error: unknown): boolean {
  return anyCause(error, ["WorkflowRunNotFoundError", "RunExpiredError"]);
}

/** The run can't take commands: missing, expired, or held by another writer. */
export function isRunInactive(error: unknown): boolean {
  return isRunMissing(error) || anyCause(error, ["EntityConflictError"]);
}

/** A hook or run can no longer accept traffic: its hook is gone, or the run is inactive. */
export function isRunTargetGone(error: unknown): boolean {
  return anyCause(error, [
    "HookNotFoundError",
    "WorkflowRunNotFoundError",
    "RunExpiredError",
    "EntityConflictError",
  ]);
}
