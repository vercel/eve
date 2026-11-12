import type { JsonObject } from "#shared/json.js";
import {
  classifyModelCallError,
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
  findMaskedByokFailure,
} from "#harness/model-call/errors.js";
import type { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { createErrorId, createLogger, formatError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { Step } from "#harness/step/context.js";
import type { StepResult } from "#harness/types.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { extractWorkflowStreamWriteErrorDetails } from "#harness/workflow-stream-error.js";
import { fail } from "#harness/session-machine/transitions.js";
import { type SemanticErrorSummary, summarizeKnownError } from "#harness/semantic-errors/index.js";
import { changeHistory } from "#harness/session-machine/history.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  turnAnchorOf,
} from "#harness/messages.js";

const log = createLogger("harness.tool-loop");

/** A failed model call as the stream reports it: what a reader can act on, not the SDK's dump. */
export function modelCallErrorInfo(error: unknown): ErrorInfo {
  const message =
    summarizeModelCallError(error)?.message ??
    extractUpstreamRejectionMessage(error)?.message ??
    toErrorMessage(error);
  return { code: "MODEL_CALL_FAILED", message };
}

/** The catalog would read AI Gateway's retry of a masked BYOK failure, so it names none. */
function summarizeModelCallError(error: unknown): SemanticErrorSummary | null {
  return findMaskedByokFailure(error) === undefined ? summarizeKnownError(error) : null;
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
    return { next: null, session: step.session };
  }

  const summary = summarizeModelCallError(error);
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
      next: step.hasDelegatedCaller
        ? { done: true, isError: true, output }
        : { done: true, output: "" },
      session: step.session,
    };
  if (summary?.tags.includes("refused") === true && turnId !== undefined) {
    const rewrite = withoutTurnInput(step.session.history, turnId);
    if (rewrite !== undefined) step.session = changeHistory(step.session, { rewrite });
  }
  step.session = { ...step.session, outputSchema: undefined };
  return { next: null, session: step.session, settledTurn: { isError: true, output } };
}

// The model learns a turn was refused, so it doesn't repeat it unaware, without reading what it said.
const REFUSED_TURN_NOTE = createFrameworkUserMessage(
  "context.instruction",
  "The model provider refused a response in this turn, so the turn ended with an error and the request that started it was removed from this conversation. Any tool calls that follow ran before the refusal.",
);

/**
 * History with the turn's input replaced by a note, or `undefined` when history holds none of it.
 * The input stays in the stream, but the model doesn't read it again: sent with the next turn, it
 * would be refused too. The tool calls the turn already ran stay, since they happened, and the
 * note keeps them behind a user message, as providers require.
 */
function withoutTurnInput(
  history: readonly HarnessModelMessage[],
  turnId: string,
): HarnessModelMessage[] | undefined {
  let noted = false;
  const rewrite = history.flatMap((message, index) => {
    if (turnAnchorOf(message) !== turnId) return [message];
    if (noted) return [];
    noted = true;
    // Consecutive refused turns share one note.
    return history[index - 1]?.content === REFUSED_TURN_NOTE.content ? [] : [REFUSED_TURN_NOTE];
  });
  return noted ? rewrite : undefined;
}

/**
 * Compaction could not bring the history under the limit. The next attempt
 * would fail the same way, so the session ends with the message instead of
 * the step being retried.
 */
export async function reportCompactionFailure(
  step: Step,
  error: CompactionOverLimitError,
): Promise<StepResult> {
  const { sessionId } = step.session;
  log.error(error.message, { sessionId, turnId: step.position().turnId });
  await step.apply(
    fail(step.view(), {
      code: "COMPACTION_FAILED",
      message: error.message,
      terminal: true,
    }),
  );
  return {
    next: step.hasDelegatedCaller
      ? { done: true, isError: true, output: error.message }
      : { done: true, output: "" },
    session: step.session,
  };
}
