import { contextStorage, type ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";

const TURN_FAILING_TOOL_ERROR_NAME = "TurnFailingToolError";

/**
 * Thrown by a tool's `execute` to fail the turn. Any other error becomes a
 * tool-error result the model reads and can work around; this one ends the
 * turn as failed with `code` and `message`, and the session waits for the
 * next message.
 */
export class TurnFailingToolError extends Error {
  readonly code: string;

  constructor(input: { readonly code: string; readonly message: string }) {
    super(input.message);
    this.name = TURN_FAILING_TOOL_ERROR_NAME;
    this.code = input.code;
  }
}

// Virtual: the AI SDK turns a thrown execute error into a tool result, so the
// harness keeps the error here and reads it back before the next model call.
const TurnFailingToolErrorKey = new ContextKey<TurnFailingToolError>("eve.turnFailingToolError");

/** Records `error` for the current step when it is a {@link TurnFailingToolError}. */
export function recordTurnFailingToolError(error: unknown): void {
  const ctx = contextStorage.getStore();
  if (ctx === undefined || !isTurnFailingToolError(error)) return;
  (ctx as ContextContainer).setVirtualContext(TurnFailingToolErrorKey, error);
}

/** Returns the error a tool threw in this step to fail the turn, if any. */
export function readTurnFailingToolError(): TurnFailingToolError | undefined {
  return contextStorage.getStore()?.get(TurnFailingToolErrorKey);
}

// Matched by name so the check holds across separately bundled copies of eve.
function isTurnFailingToolError(error: unknown): error is TurnFailingToolError {
  return (
    error instanceof Error &&
    error.name === TURN_FAILING_TOOL_ERROR_NAME &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
