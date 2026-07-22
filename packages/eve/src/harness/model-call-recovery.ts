import type { ModelMessage, ToolSet, TypedToolCall, TypedToolError, TypedToolResult } from "ai";
import { createLogger, formatError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { resolveAssistantStepText } from "#harness/messages.js";
import {
  classifyModelCallError,
  EmptyModelResponseError,
  extractUnsupportedProviderToolTypes,
  isNoOutputGeneratedError,
  type UpstreamRejectionSummary,
} from "#harness/model-call-error.js";
import { resolveFrameworkToolFromUpstreamType } from "#harness/provider-tools.js";
import type { SemanticErrorSummary } from "#harness/semantic-errors/index.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { getInvalidToolCallInputError } from "#harness/tool-call-input-errors.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#runtime/framework-tools/final-output.js";

const log = createLogger("harness.generate");

/**
 * Max attempts (1 original + N retries) for transient model-call
 * failures before the harness gives up and falls back to the
 * recoverable/terminal emission path. Kept small on purpose — every
 * attempt costs a round-trip plus prompt tokens, and the dominant
 * use case (429 / 502) clears quickly or not at all.
 */
const MODEL_CALL_MAX_ATTEMPTS = 3;

/**
 * Base delay (ms) between model-call retries. Doubled each attempt,
 * plus a small random jitter to avoid thundering-herd behavior when
 * a provider incident clears.
 */
const MODEL_CALL_RETRY_BASE_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Model-call failure projection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unsupported provider tool recovery
// ---------------------------------------------------------------------------

/**
 * Call options a failing recovery retry used. A subsequent recovery
 * repeats the same call shape instead of silently restoring state the
 * earlier recovery removed (e.g. a provider tool the gateway rejected).
 */
type RecoveryRetryCallOptions = {
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly extraSystemNote?: string;
};

/**
 * The slice of `runOneModelCall` a recovery stage may use for its retry.
 */
type RecoveryModelCallFn = (
  opts: RecoveryRetryCallOptions & {
    readonly retryReason?: "empty-response";
    readonly suppressStepStartedEmission?: boolean;
    readonly trailingUserNote?: string;
  },
) => Promise<HarnessStepResult>;

/**
 * Shared arms of a recovery outcome, and what
 * {@link runModelCallRecoveryPipeline} resolves to.
 *
 * - `recovered`: the retry call succeeded and the wrapped result should
 *   flow into the normal post-step handling.
 * - `failed`: the recovery acted and its retry also failed. The wrapped
 *   error replaces the current error; `retryCallOptions`, when present,
 *   is the call shape the failing retry used.
 */
type ModelCallRecoveryBase =
  | { readonly outcome: "recovered"; readonly result: HarnessStepResult }
  | {
      readonly outcome: "failed";
      readonly error: unknown;
      readonly retryCallOptions?: RecoveryRetryCallOptions;
    };

/**
 * Outcome of a single recovery stage
 * ({@link attemptUnsupportedProviderToolRecovery},
 * {@link attemptEmptyResponseRecovery}): the shared arms plus `skipped`,
 * returned when the error does not match the stage's trigger so the
 * pipeline passes the current error on unchanged.
 */
type ModelCallRecoveryResult = ModelCallRecoveryBase | { readonly outcome: "skipped" };

/**
 * One stage of {@link runModelCallRecoveryPipeline}: receives the current
 * error plus the call shape of the previous stage's failing retry.
 */
type ModelCallRecoveryStage = (current: {
  readonly error: unknown;
  readonly retryCallOptions?: RecoveryRetryCallOptions;
}) => Promise<ModelCallRecoveryResult>;

/**
 * Runs the model-call recovery stages in order against the current error.
 *
 * Each stage checks its own trigger and returns `skipped` for errors it
 * does not handle, leaving the current error for the next stage. A stage
 * that acts either ends the pipeline with `recovered` or replaces the
 * current error with its retry's failure, so a later stage can match the
 * transformed error (a tool-drop retry can itself come back empty). The
 * trigger check stays inside the stage because it can be multi-phase: the
 * tool recovery also skips when no rejected type maps to a known framework
 * tool. `retryCallOptions` carries the failing retry's call shape to the
 * next stage so a reissue repeats what that retry sent.
 */
export async function runModelCallRecoveryPipeline(input: {
  readonly error: unknown;
  readonly stages: readonly ModelCallRecoveryStage[];
}): Promise<ModelCallRecoveryBase> {
  let error = input.error;
  let retryCallOptions: RecoveryRetryCallOptions | undefined;
  for (const stage of input.stages) {
    const outcome = await stage({ error, retryCallOptions });
    if (outcome.outcome === "recovered") {
      return outcome;
    }
    if (outcome.outcome === "failed") {
      error = outcome.error;
      retryCallOptions = outcome.retryCallOptions;
    }
  }
  return { outcome: "failed", error };
}

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;
type StepResponseMessage = HarnessStepResult["response"]["messages"][number];

export function withAccumulatedResponseMessages(input: {
  readonly invalidInputToolCallIds?: ReadonlySet<string>;
  readonly responseMessages: readonly StepResponseMessage[];
  readonly stepResult: HarnessStepResult;
  readonly toolResults?: readonly TypedToolResult<ToolSet>[];
}): HarnessStepResult {
  const { stepResult } = input;

  /*
   * AI SDK `StepResult` fields are prototype getters, so spreading the
   * instance drops them. Materialize each field while replacing the final
   * step's messages with the SDK's accumulated response, which also contains
   * approval-resume results created before the model step.
   */
  return {
    content: stepResult.content,
    finishReason: stepResult.finishReason,
    ...(input.invalidInputToolCallIds === undefined
      ? {}
      : { invalidInputToolCallIds: input.invalidInputToolCallIds }),
    providerMetadata: stepResult.providerMetadata,
    response: {
      ...stepResult.response,
      messages: [...input.responseMessages],
    },
    text: stepResult.text,
    toolCalls: stepResult.toolCalls,
    toolResults: input.toolResults === undefined ? stepResult.toolResults : [...input.toolResults],
    usage: stepResult.usage,
  };
}

export function appendMissingToolResultMessages(input: {
  readonly append: readonly ToolResultPart[];
  readonly responseMessages: readonly StepResponseMessage[];
}): StepResponseMessage[] {
  const existingCallIds = extractToolResultCallIds(input.responseMessages);
  const append = input.append.filter((part) => !existingCallIds.has(part.toolCallId));

  return [
    ...input.responseMessages,
    ...(append.length > 0 ? [{ role: "tool" as const, content: [...append] }] : []),
  ] satisfies StepResponseMessage[];
}

export function getInvalidToolCallInputErrors(input: {
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
}): readonly TypedToolError<ToolSet>[] {
  const errors: TypedToolError<ToolSet>[] = [];

  for (const toolCall of input.toolCalls) {
    if (toolCall.toolName === FINAL_OUTPUT_TOOL_NAME) {
      continue;
    }

    const toolError = getInvalidToolCallInputError({ toolCall });
    if (toolError !== undefined) {
      errors.push(toolError);
    }
  }

  return errors;
}

export function extractToolResultCallIds(
  messages: readonly StepResponseMessage[],
): ReadonlySet<string> {
  const callIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-result") {
        callIds.add(part.toolCallId);
      }
    }
  }

  return callIds;
}

/**
 * Inspects a model-call failure for the "tool type 'X' is not supported"
 * provider-attempt rejection that AI Gateway returns when a fallback
 * provider cannot serve a provider-specific tool. On a match, retries the
 * step once with the offending tool dropped and a one-shot system note
 * telling the model which capability has been removed.
 *
 * Returns `recovered` when the retry succeeded so the caller can hand
 * the result off to the usual post-step handler. Returns `failed`
 * (with the original error, or the retry's error if the retry also
 * threw) otherwise so the caller's existing terminal/recoverable
 * cascade still runs.
 *
 * Recovery is intentionally scoped to known provider tools — entries in
 * {@link UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME} — so an unrelated
 * upstream rejection cannot accidentally drop a user-authored tool.
 */
export async function attemptUnsupportedProviderToolRecovery(input: {
  readonly error: unknown;
  readonly runOneModelCall: RecoveryModelCallFn;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<ModelCallRecoveryResult> {
  const unsupportedTypes = extractUnsupportedProviderToolTypes(input.error);
  if (unsupportedTypes.length === 0) {
    return { outcome: "skipped" };
  }

  const toolsToDisable: string[] = [];
  for (const type of unsupportedTypes) {
    const frameworkName = resolveFrameworkToolFromUpstreamType(type);
    if (frameworkName !== null && !toolsToDisable.includes(frameworkName)) {
      toolsToDisable.push(frameworkName);
    }
  }

  if (toolsToDisable.length === 0) {
    return { outcome: "skipped" };
  }

  log.warn("disabling unsupported provider tool(s); retrying step once", {
    disabled: toolsToDisable,
    sessionId: input.sessionId,
    turnId: input.turnId,
    upstreamTypes: unsupportedTypes,
  });

  const retryCallOptions: RecoveryRetryCallOptions = {
    disabledProviderTools: new Set(toolsToDisable),
    extraSystemNote: buildDisabledToolNote(toolsToDisable),
  };
  try {
    const result = await input.runOneModelCall({
      ...retryCallOptions,
      suppressStepStartedEmission: true,
    });
    return { outcome: "recovered", result };
  } catch (retryError) {
    return { outcome: "failed", error: retryError, retryCallOptions };
  }
}

/**
 * Builds the one-shot system note prepended to the recovery retry's
 * instructions so the model has explicit context for why a capability
 * disappeared mid-turn.
 */
function buildDisabledToolNote(toolNames: readonly string[]): string {
  const list = toolNames.join(", ");
  const noun = toolNames.length === 1 ? "tool is" : "tools are";
  return (
    `The following ${noun} not available with the current model and ` +
    `has been removed: ${list}. Proceed using the remaining tools or your ` +
    `training knowledge.`
  );
}

/**
 * True when a step produced no assistant text and no tool calls. Intentional
 * silence uses {@link EMPTY_DELIVERY_SENTINEL}; a genuinely blank response is
 * ambiguous and must be retried instead of silently dropping a HITL reply.
 */
export function isEmptyModelResponse(step: HarnessStepResult): boolean {
  return (
    step.toolCalls.length === 0 &&
    step.toolResults.length === 0 &&
    resolveAssistantStepText(step.response.messages, step.text) === null
  );
}

/**
 * Rethrows the AI SDK's `NoOutputGeneratedError` as
 * {@link EmptyModelResponseError}. Since `ai@7.0.0-canary.169`
 * (vercel/ai#15938) a stream that closes after metadata without output or
 * a finish chunk rejects — the SDK enqueues the error onto `fullStream`
 * (so `emitStreamContent` throws it) and never emits `finish-step`, so
 * `onStepFinish` does not fire and the step hooks' `stepResult` promise
 * would never settle. The same condition previously completed as an empty
 * step caught by {@link isEmptyModelResponse}; normalizing here funnels
 * both shapes into the one-shot empty-response reissue.
 */
export function rethrowNoOutputAsEmptyResponse(error: unknown): never {
  if (isNoOutputGeneratedError(error)) {
    throw new EmptyModelResponseError({ cause: error });
  }
  throw error;
}

/**
 * Wire-only note the empty-response reissue appends to its retry, so the
 * model answers from the tool results already in context instead of
 * re-exploring. Each recovery stage declares its own follow-up text: the
 * tool recovery prepends {@link buildDisabledToolNote} as a system note
 * (its toolset change busts the prompt cache anyway), this one trails as
 * a user note to keep the cached prefix valid.
 */
const EMPTY_RESPONSE_NUDGE =
  "Your previous reply was empty and was not delivered. Answer now from the tool results above; do not re-run tools or mention this notice.";

function buildEmptyResponseNudge(emptyDeliveryEnabled: boolean): string {
  if (!emptyDeliveryEnabled) {
    return EMPTY_RESPONSE_NUDGE;
  }
  return `${EMPTY_RESPONSE_NUDGE} If the current task explicitly requires conditional delivery and there is nothing to report, reply with exactly ${EMPTY_DELIVERY_SENTINEL}.`;
}

/**
 * Recovers a model call that completed without content (see
 * {@link EmptyModelResponseError}) by reissuing the same call once, with
 * {@link EMPTY_RESPONSE_NUDGE} appended to the wire request. If the
 * reissue also fails, the caller's failure floor takes over.
 *
 * The reissue goes through `runOneModelCall` so it gets fresh step hooks;
 * the previous attempt's one-shot `stepResult` promise has already resolved
 * and would feed a same-hooks retry the stale empty result. The reissue
 * stays within the current step: the empty attempt emitted no step.completed
 * (an approval-resume step may have surfaced inline action results before
 * the throw), and `suppressStepStartedEmission` avoids a duplicate
 * step.started. When the empty response came from another recovery's retry,
 * `retryCallOptions` repeats that call's shape so the reissue does not
 * restore what the earlier recovery removed.
 */
export async function attemptEmptyResponseRecovery(input: {
  readonly emptyDeliveryEnabled: boolean;
  readonly error: unknown;
  readonly retryCallOptions?: RecoveryRetryCallOptions;
  readonly runOneModelCall: RecoveryModelCallFn;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<ModelCallRecoveryResult> {
  if (!(input.error instanceof EmptyModelResponseError)) {
    return { outcome: "skipped" };
  }

  log.warn("empty model response; reissuing the model call once", {
    sessionId: input.sessionId,
    turnId: input.turnId,
  });

  try {
    const result = await input.runOneModelCall({
      ...input.retryCallOptions,
      retryReason: "empty-response",
      suppressStepStartedEmission: true,
      trailingUserNote: buildEmptyResponseNudge(input.emptyDeliveryEnabled),
    });
    return { outcome: "recovered", result };
  } catch (retryError) {
    return { outcome: "failed", error: retryError, retryCallOptions: input.retryCallOptions };
  }
}

/**
 * Retries `fn` with exponential backoff while the thrown error is
 * classified as `"retry"`. Rethrows the last error once attempts are
 * exhausted or the error is classified as something other than
 * transient.
 */
export async function runModelCallWithRetries<T>(
  fn: (attempt: number) => Promise<T>,
  diag: { readonly sessionId: string; readonly turnId: string },
  abortSignal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    throwIfTurnAborted(abortSignal);
    try {
      return await fn(attempt);
    } catch (error) {
      throwIfTurnAborted(abortSignal);
      if (attempt === MODEL_CALL_MAX_ATTEMPTS || classifyModelCallError(error) !== "retry") {
        throw error;
      }
      const delayMs =
        MODEL_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      log.warn("model call failed transiently — retrying", {
        attempt,
        delayMs,
        sessionId: diag.sessionId,
        turnId: diag.turnId,
        error,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
