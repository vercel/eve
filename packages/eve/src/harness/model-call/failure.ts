import type { JsonObject } from "#shared/json.js";
import {
  classifyModelCallError,
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
} from "#harness/model-call/errors.js";
import { createErrorId, createLogger, formatError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { Step } from "#harness/step/context.js";
import type { StepResult } from "#harness/types.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { extractWorkflowStreamWriteErrorDetails } from "#harness/workflow-stream-error.js";
import { fail } from "#harness/session-machine/transitions.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";

const log = createLogger("harness.tool-loop");

/** A failed model call as the stream reports it: what a reader can act on, not the SDK's dump. */
export function modelCallErrorInfo(error: unknown): ErrorInfo {
  const message =
    summarizeKnownError(error)?.message ??
    extractUpstreamRejectionMessage(error)?.message ??
    toErrorMessage(error);
  return { code: "MODEL_CALL_FAILED", message };
}

/** Exhausted model calls fail the turn; terminal errors end its session as well. */
export async function reportModelCallFailure(step: Step, error: unknown): Promise<StepResult> {
  // The AI SDK's span omits the cause chain and upstream response body.
  step.instrumentation?.recordError(error);
  if (step.emit === undefined) throw error;
  const { sessionId } = step.session;
  const { turnId } = step.position();
  const errorId = createErrorId();
  const coordinates = { errorId, sessionId, turnId };
  const streamWriteDetails = extractWorkflowStreamWriteErrorDetails(error);
  if (streamWriteDetails !== null) {
    log.error("workflow stream write failed — parking session for retry by the user", {
      ...streamWriteDetails,
      ...coordinates,
      error,
    });
    await step.apply(
      fail(step.view(), {
        code: "WORKFLOW_STREAM_WRITE_FAILED",
        details: { ...streamWriteDetails, errorId },
        message: toErrorMessage(error),
      }),
    );
    return { session: step.session };
  }

  const summary = summarizeKnownError(error);
  const rejection = summary === null ? extractUpstreamRejectionMessage(error) : null;
  const message = summary?.message ?? rejection?.message ?? toErrorMessage(error);
  // A delegated caller reads the remedy as prose; events keep it structured.
  const output = summary?.hint === undefined ? message : `${message} ${summary.hint}`;
  const diagnostics = extractModelCallErrorDetails(error);
  const details: JsonObject =
    summary !== null
      ? {
          errorId,
          message: summary.message,
          name: summary.name,
          semanticErrorId: summary.id,
          ...diagnostics,
          ...(summary.hint !== undefined && { hint: summary.hint }),
        }
      : rejection !== null
        ? { errorId, message: toErrorMessage(error), name: rejection.name, ...diagnostics }
        : { ...formatError(error, errorId), ...diagnostics };
  const terminal = classifyModelCallError(error) === "terminal";
  if (terminal && summary !== null) {
    log.error(`${summary.name}: ${summary.message}`, { ...coordinates, hint: summary.hint });
  } else {
    log.error(
      rejection?.message ??
        (terminal
          ? "model call failed terminally"
          : "model call failed — parking session for retry by the user"),
      // Recognized failures use compact diagnostics, not an inspector dump of their cause chain.
      summary !== null || rejection !== null
        ? { ...coordinates, details: diagnostics }
        : { ...coordinates, error },
    );
  }
  await step.apply(
    fail(step.view(), {
      code: "MODEL_CALL_FAILED",
      details,
      message,
      ...(terminal && { terminal: true }),
    }),
  );
  if (terminal)
    return {
      ended: step.hasDelegatedCaller ? { isError: true, output } : { output: "" },
      session: step.session,
    };
  step.session = { ...step.session, outputSchema: undefined };
  return { session: step.session, settledTurn: { isError: true, output } };
}
