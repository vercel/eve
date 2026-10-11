import type { JsonObject, JsonValue } from "#shared/json.js";
import type { SemanticErrorSummary } from "#harness/semantic-errors/rule.js";
import {
  classifyModelCallError,
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
  type UpstreamRejectionSummary,
} from "#harness/model-call/errors.js";
import { createErrorId, createLogger, formatError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { Step } from "#harness/step/context.js";
import type { StepResult } from "#harness/types.js";
import { extractWorkflowStreamWriteErrorDetails } from "#harness/workflow-stream-error.js";
import { fail } from "#harness/session-machine/transitions.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";

const log = createLogger("harness.tool-loop");
/**
 * Projects a model-call failure into the `step.failed` / `turn.failed`
 * `details` payload. Three mutually exclusive branches:
 *
 * 1. Catalog match → the rule's curated `name`/`message`/`hint` plus its
 *    registered `semanticErrorId`, no SDK inspector dump.
 * 2. Upstream rejection → raw error `message` with the extracted upstream
 *    identity, no inspector dump. No `semanticErrorId`: the message is
 *    arbitrary provider prose, not a registered failure shape.
 * 3. Fallback → full {@link formatError} projection (cause chain via
 *    `util.inspect`) so unrecognized failures still carry the upstream
 *    stack to log aggregators.
 *
 * All branches merge {@link extractModelCallErrorDetails} on top so the
 * compact gateway diagnostics (`statusCode`, `upstreamMessage`,
 * `responseBodySnippet`, ...) always show up next to the message.
 */
export function buildModelCallFailureDetails(input: {
  readonly catalogSummary: SemanticErrorSummary | null;
  readonly error: unknown;
  readonly errorId: string;
  readonly modelCallDetails: JsonObject;
  readonly upstreamRejection: UpstreamRejectionSummary | null;
}): JsonObject {
  const { catalogSummary, error, errorId, modelCallDetails, upstreamRejection } = input;

  if (catalogSummary !== null) {
    const details: Record<string, JsonValue> = {
      errorId,
      message: catalogSummary.message,
      name: catalogSummary.name,
      semanticErrorId: catalogSummary.id,
      ...modelCallDetails,
    };
    if (catalogSummary.hint !== undefined) details.hint = catalogSummary.hint;
    return details;
  }

  if (upstreamRejection !== null) {
    return {
      errorId,
      message: toErrorMessage(error),
      name: upstreamRejection.name,
      ...modelCallDetails,
    };
  }

  return { ...formatError(error, errorId), ...modelCallDetails };
}

/**
 * Builds the structured log fields for a model-call failure. When the
 * failure was recognized (catalog match or extracted upstream rejection),
 * attach the compact `details` payload and *omit* the raw `error` so the
 * logger's `util.inspect` of the cause chain (which would render
 * `[object Object]` for upstream `APICallError` shapes) is bypassed.
 * Otherwise fall back to the raw error so unrecognized failures keep
 * their full stack in logs.
 */
export function buildModelCallFailureLogFields(input: {
  readonly error: unknown;
  readonly errorId: string;
  readonly modelCallDetails: JsonObject;
  readonly recognized: boolean;
  readonly sessionId: string;
  readonly turnId: string;
}): Record<string, unknown> {
  const base = {
    errorId: input.errorId,
    sessionId: input.sessionId,
    turnId: input.turnId,
  };
  if (input.recognized) {
    return { ...base, details: input.modelCallDetails };
  }
  return { ...base, error: input.error };
}

/**
 * The model call failed past its retries and recoveries. A failed write to the session's stream is
 * the workflow's failure, not the model's: the session parks for the user to retry. A terminal
 * failure ends the session; any other fails the turn recoverably.
 */
export async function reportModelCallFailure(step: Step, error: unknown): Promise<StepResult> {
  // Surface the full cause chain and upstream response body to OTel via the turn span: the AI
  // SDK's own span records only `error.stack`, without `cause`.
  step.instrumentation?.recordError(error);
  // Callers without an event handler (tests, task-only paths) get the raw error.
  if (step.emit === undefined) throw error;
  const { sessionId } = step.session;
  const { turnId } = step.position();

  const streamWriteDetails = extractWorkflowStreamWriteErrorDetails(error);
  if (streamWriteDetails !== null) {
    const errorId = createErrorId();
    log.error("workflow stream write failed — parking session for retry by the user", {
      ...streamWriteDetails,
      errorId,
      error,
      sessionId,
      turnId,
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

  const errorId = createErrorId();
  const catalogSummary = summarizeKnownError(error);
  const upstreamRejection = catalogSummary === null ? extractUpstreamRejectionMessage(error) : null;
  const errorMessage =
    catalogSummary?.message ?? upstreamRejection?.message ?? toErrorMessage(error);
  // A task's failure reaches the parent agent as its tool-result text, so the remedy rides along
  // in prose; event payloads keep the hint structured in `details`.
  const taskFailureOutput =
    catalogSummary?.hint === undefined ? errorMessage : `${errorMessage} ${catalogSummary.hint}`;
  const modelCallDetails = extractModelCallErrorDetails(error);
  const details = buildModelCallFailureDetails({
    catalogSummary,
    error,
    errorId,
    modelCallDetails,
    upstreamRejection,
  });
  const logFields = buildModelCallFailureLogFields({
    error,
    errorId,
    modelCallDetails,
    recognized: catalogSummary !== null || upstreamRejection !== null,
    sessionId,
    turnId,
  });

  if (classifyModelCallError(error) === "terminal") {
    if (catalogSummary !== null) {
      // A recognized configuration failure logs one actionable line, not the SDK's dump.
      log.error(`${catalogSummary.name}: ${catalogSummary.message}`, {
        errorId,
        hint: catalogSummary.hint,
        sessionId,
        turnId,
      });
    } else {
      log.error(upstreamRejection?.message ?? "model call failed terminally", logFields);
    }
    await step.apply(
      fail(step.view(), {
        code: "MODEL_CALL_FAILED",
        details,
        message: errorMessage,
        terminal: { sessionId },
      }),
    );
    // A delegated run's caller needs a failed result to report; a conversation already ended
    // with `session.failed`.
    return {
      next: step.hasDelegatedCaller
        ? { done: true, isError: true, output: taskFailureOutput }
        : { done: true, output: "" },
      session: step.session,
    };
  }

  log.error(
    upstreamRejection?.message ?? "model call failed — parking session for retry by the user",
    logFields,
  );
  await step.apply(
    fail(step.view(), { code: "MODEL_CALL_FAILED", details, message: errorMessage }),
  );
  step.session = { ...step.session, outputSchema: undefined };
  return {
    next: null,
    session: step.session,
    settledTurn: { isError: true, output: taskFailureOutput },
  };
}
