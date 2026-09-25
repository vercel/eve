import {
  EntityConflictError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import { walkCauseChain } from "#shared/errors.js";

export function isMissingDevelopmentRunError(error: unknown): boolean {
  return [...walkCauseChain(error)].some(
    (cause) => WorkflowRunNotFoundError.is(cause) || RunExpiredError.is(cause),
  );
}

export function isInactiveDevelopmentRunError(error: unknown): boolean {
  return (
    isMissingDevelopmentRunError(error) ||
    [...walkCauseChain(error)].some((cause) => EntityConflictError.is(cause))
  );
}
