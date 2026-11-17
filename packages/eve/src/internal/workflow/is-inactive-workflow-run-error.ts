import {
  EntityConflictError,
  RunExpiredError,
  StreamExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import { walkCauseChain } from "#shared/errors.js";

export function isExpiredWorkflowRunError(error: unknown): boolean {
  return [...walkCauseChain(error)].some(
    (cause) => RunExpiredError.is(cause) || StreamExpiredError.is(cause),
  );
}

export function isMissingWorkflowRunError(error: unknown): boolean {
  return [...walkCauseChain(error)].some(
    (cause) => WorkflowRunNotFoundError.is(cause) || RunExpiredError.is(cause),
  );
}

export function isInactiveWorkflowRunError(error: unknown): boolean {
  return (
    isMissingWorkflowRunError(error) ||
    [...walkCauseChain(error)].some((cause) => EntityConflictError.is(cause))
  );
}
