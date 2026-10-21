import { getStepMetadata } from "#compiled/@workflow/core/index.js";

/** Thrown in place of a `replay: "never"` call when its durable step runs again. */
export class ToolRecoveryRequiredError extends Error {
  readonly code = "TOOL_RECOVERY_REQUIRED";

  constructor(toolName: string) {
    super(
      `TOOL_RECOVERY_REQUIRED: eve did not run ${toolName} because the durable step around it ` +
        "was interrupted and is running again. An earlier attempt may already have taken effect. " +
        "Check before retrying, or ask the user to confirm.",
    );
    this.name = "ToolRecoveryRequiredError";
  }
}

/** Whether this code runs in a durable step that already ran at least once. */
function isRetriedStep(): boolean {
  try {
    return getStepMetadata().attempt > 1;
  } catch {
    // Outside a durable step nothing can replay.
    return false;
  }
}

/** Refuses a `replay: "never"` tool's execution when its durable step re-runs. */
export function refuseOnReplay<TArgs extends unknown[], TResult>(
  toolName: string,
  execute: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args) => {
    if (isRetriedStep()) throw new ToolRecoveryRequiredError(toolName);
    return execute(...args);
  };
}
