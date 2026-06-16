import type { NextDriverAction } from "#execution/next-driver-action.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { turnStep } from "#execution/workflow-steps.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

/**
 * Hook payload the turn child workflow delivers to the parent driver
 * on completion. `turn-result` wraps a {@link NextDriverAction} the
 * driver dispatches on; `turn-error` carries a normalized error the
 * driver rethrows.
 */
export type TurnCompletionPayload =
  | { readonly kind: "turn-result"; readonly action: NextDriverAction }
  | { readonly kind: "turn-error"; readonly error: unknown };

export type { TurnWorkflowInput };

/**
 * Short-lived workflow that owns one runtime turn for the driver.
 *
 * `parentWritable` is threaded in from the driver run so event writes
 * land on the driver's stream. Resolves the turn into a
 * {@link NextDriverAction} and reports it back through
 * {@link notifyDriverStep}.
 */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);
  let currentStepInput: TurnStepInput = input.stepInput;

  try {
    while (true) {
      const result = await turnStep(currentStepInput);

      if (result.action === "done") {
        await notifyDriverStep({
          completionToken: input.completionToken,
          payload: {
            action: {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "dispatch-code-mode-runtime-actions") {
        await notifyDriverStep({
          completionToken: input.completionToken,
          payload: {
            action: {
              kind: "dispatch-code-mode-runtime-actions",
              pendingActionKeys: result.pendingRuntimeActionKeys,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "park") {
        const pendingActionKeys = result.pendingRuntimeActionKeys;
        const canPark =
          pendingActionKeys !== undefined ||
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) {
          throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);
        }

        const action: NextDriverAction =
          pendingActionKeys !== undefined
            ? {
                kind: "dispatch-runtime-actions",
                pendingActionKeys,
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
              }
            : {
                kind: "park",
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
                authorizationNames: result.authorizationNames,
              };

        await notifyDriverStep({
          completionToken: input.completionToken,
          payload: { action, kind: "turn-result" },
        });
        return;
      }

      currentStepInput = {
        input: undefined,
        parentWritable: currentStepInput.parentWritable,
        serializedContext: result.serializedContext,
        sessionState: result.sessionState,
      };
    }
  } catch (error) {
    await notifyDriverStep({
      completionToken: input.completionToken,
      payload: {
        error: normalizeSerializableError(error),
        kind: "turn-error",
      },
    });
    throw error;
  }
}

/** Resumes the driver's one-shot completion hook with the turn result. */
export async function notifyDriverStep(input: {
  readonly completionToken: string;
  readonly payload: TurnCompletionPayload;
}): Promise<void> {
  "use step";

  process.env.WORKFLOW_QUEUE_NAMESPACE = "eve";
  const { resumeHook } = await import("#compiled/@workflow/core/runtime.js");
  await resumeHook(input.completionToken, input.payload);
}
