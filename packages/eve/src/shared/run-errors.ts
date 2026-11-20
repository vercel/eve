import { walkCauseChain } from "#shared/errors.js";

export class HookNotFoundError extends Error {
  override readonly name = "HookNotFoundError";
  readonly token: string;

  constructor(token: string) {
    super("Hook not found");
    this.token = token;
  }
}

export class NonRetryableError extends Error {
  override readonly name = "FatalError";
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

export function isHookNotFound(error: unknown): boolean {
  return hasName(error, "HookNotFoundError");
}

export function isHookConflict(error: unknown): boolean {
  return hasName(error, "HookConflictError");
}

export function isRunNotFound(error: unknown): boolean {
  return anyCause(error, ["WorkflowRunNotFoundError"]);
}

export function isRunExpired(error: unknown): boolean {
  return anyCause(error, ["RunExpiredError", "StreamExpiredError"]);
}

export function isRunMissing(error: unknown): boolean {
  return anyCause(error, ["WorkflowRunNotFoundError", "RunExpiredError"]);
}

export function isRunInactive(error: unknown): boolean {
  return isRunMissing(error) || anyCause(error, ["EntityConflictError"]);
}

export function isRunTargetGone(error: unknown): boolean {
  return anyCause(error, [
    "HookNotFoundError",
    "WorkflowRunNotFoundError",
    "RunExpiredError",
    "EntityConflictError",
  ]);
}
