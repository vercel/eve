import { createLogger } from "#internal/logging.js";
import {
  EmptyModelResponseError,
  extractUnsupportedProviderToolTypes,
  isNoOutputGeneratedError,
} from "#harness/model-call/errors.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { resolveAssistantStepText } from "#harness/messages.js";
import { resolveFrameworkToolFromUpstreamType } from "#harness/provider-tools.js";

const log = createLogger("harness.tool-loop");
/** How a recovery reissues the call. */
type RecoveryCall = (options: {
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly extraSystemNote?: string;
  readonly retryReason?: "empty-response";
  readonly suppressStepStartedEmission?: boolean;
  readonly trailingUserNote?: string;
}) => Promise<HarnessStepResult>;

/**
 * Recovers a failed model call, each recovery at most once and within the current step, so the
 * reissue suppresses a second `step.started`:
 *
 * 1. AI Gateway rejected a provider-specific tool a fallback provider can't serve ("tool type 'X'
 *    is not supported"): the call is reissued without it, and a system note tells the model which
 *    capability went away. Only known provider tools are dropped, never an authored one.
 * 2. The response was empty (see {@link EmptyModelResponseError}), including the first
 *    recovery's: the call is reissued with {@link EMPTY_RESPONSE_NUDGE}, repeating what the first
 *    recovery removed.
 *
 * Each reissue goes through `call` so it gets fresh step hooks: the failed attempt's one-shot
 * `stepResult` already resolved. Returns the error that remains when nothing recovered.
 */
export async function recoverModelCall(input: {
  readonly error: unknown;
  readonly call: RecoveryCall;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<{ readonly result: HarnessStepResult } | { readonly error: unknown }> {
  let { error } = input;
  const diagnostics = { sessionId: input.sessionId, turnId: input.turnId };
  let options: Parameters<RecoveryCall>[0] = {};

  const unsupportedTypes = extractUnsupportedProviderToolTypes(error);
  const disabled = [
    ...new Set(
      unsupportedTypes.flatMap((type) => resolveFrameworkToolFromUpstreamType(type) ?? []),
    ),
  ];
  if (disabled.length > 0) {
    log.warn("disabling unsupported provider tool(s); retrying step once", {
      ...diagnostics,
      disabled,
      upstreamTypes: unsupportedTypes,
    });
    options = {
      disabledProviderTools: new Set(disabled),
      extraSystemNote: buildDisabledToolNote(disabled),
    };
    try {
      return { result: await input.call({ ...options, suppressStepStartedEmission: true }) };
    } catch (retryError) {
      error = retryError;
    }
  }

  if (error instanceof EmptyModelResponseError) {
    log.warn("empty model response; reissuing the model call once", diagnostics);
    try {
      return {
        result: await input.call({
          ...options,
          retryReason: "empty-response",
          suppressStepStartedEmission: true,
          trailingUserNote: EMPTY_RESPONSE_NUDGE,
        }),
      };
    } catch (retryError) {
      error = retryError;
    }
  }
  return { error };
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
 * True when a step produced no assistant text and no tool calls. A blank
 * response is ambiguous and must be retried instead of silently dropping a
 * HITL reply.
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
 * `onStepEnd` does not fire and the step hooks' `stepResult` promise
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
 * Wire-only note the empty-response reissue appends to its retry. Reads may
 * be refreshed when earlier results are stale; completed writes and other
 * side effects must not be repeated. Each recovery stage declares its own
 * follow-up text: tool recovery prepends {@link buildDisabledToolNote} as
 * a system note (its toolset change busts the prompt cache anyway), while
 * this one trails as a user note to keep the cached prefix valid.
 */
const EMPTY_RESPONSE_NUDGE =
  "Your previous reply was empty and was not delivered. Continue the current user request. Reuse completed results when they satisfy the request. If existing results are stale or insufficient, use the appropriate read tools to get fresh results. Do not repeat writes or other side effects that already completed. Do not mention this notice.";
