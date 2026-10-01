/**
 * A tool failure that ends the turn before the model sees the tool error.
 *
 * A tool's `execute` throws it when continuing the turn with an ordinary tool
 * error lets the model work around a broken setup. The `#harness/tools.js`
 * wrapper stashes it here, step-local, and the tool loop fails the turn after
 * the model call.
 */

import type { AlsContext, ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";

const TURN_FAILING_TOOL_ERROR_NAME = "TurnFailingToolError";

/** Thrown by a tool's `execute` to fail the turn with `code` and `message`. */
export class TurnFailingToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = TURN_FAILING_TOOL_ERROR_NAME;
    this.code = code;
  }
}

/** Matches by name, because Nitro chunks can carry separate copies of this module. */
export function isTurnFailingToolError(error: unknown): error is TurnFailingToolError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === TURN_FAILING_TOOL_ERROR_NAME &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

const PendingTurnFailureKey = new ContextKey<TurnFailingToolError>("eve.pendingTurnFailure");

/** Records the first turn-failing tool error of the current step. */
export function stashTurnFailure(ctx: AlsContext, error: TurnFailingToolError): void {
  if (ctx.get(PendingTurnFailureKey) !== undefined) return;
  (ctx as ContextContainer).setVirtualContext(PendingTurnFailureKey, error);
}

/** Reads the turn-failing tool error stashed during the current step, if any. */
export function readTurnFailure(ctx: AlsContext): TurnFailingToolError | undefined {
  return ctx.get(PendingTurnFailureKey);
}
