import { createLogger } from "#internal/logging.js";
import {
  EmptyModelResponseError,
  extractMaxOutputTokensRejection,
  extractUnsupportedProviderToolTypes,
  isNoOutputGeneratedError,
} from "#harness/model-call/errors.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { resolveAssistantStepText } from "#harness/messages.js";
import { resolveFrameworkToolFromUpstreamType } from "#harness/provider-tools.js";

import type { ModelCallOptions } from "./call.js";

const log = createLogger("harness.tool-loop");

const MAX_EMPTY_RESPONSE_RETRIES = 3;

export function recoverModelCall(
  error: unknown,
  options: ModelCallOptions,
  diagnostics: { readonly sessionId: string; readonly turnId: string },
): ModelCallOptions | undefined {
  if (options.disabledProviderTools === undefined && options.retryReason === undefined) {
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
      return {
        ...options,
        disabledProviderTools: new Set(disabled),
        extraSystemNote: buildDisabledToolNote(disabled),
      };
    }
  }
  if (options.maxOutputTokensOverride === undefined) {
    const rejection = extractMaxOutputTokensRejection(error);
    if (rejection !== undefined) {
      log.warn("provider rejected maxOutputTokens; retrying step with adjusted cap", {
        ...diagnostics,
        maxAllowed: rejection.maxAllowed ?? null,
      });
      return {
        ...options,
        maxOutputTokensOverride: rejection.maxAllowed ?? null,
      };
    }
  }
  if (!(error instanceof EmptyModelResponseError)) return undefined;
  const attempts = options.emptyResponseAttempts ?? 0;
  if (attempts >= MAX_EMPTY_RESPONSE_RETRIES) return undefined;
  log.warn("empty model response; reissuing the model call", {
    ...diagnostics,
    attempt: attempts + 1,
    finishReason: error.finishReason,
  });
  return {
    ...options,
    emptyResponseAttempts: attempts + 1,
    ...(error.finishReason === "length" && { reasoningOverride: "low" as const }),
    retryReason: "empty-response",
    trailingUserNote: buildEmptyResponseNudge(error),
  };
}

function buildDisabledToolNote(toolNames: readonly string[]): string {
  const list = toolNames.join(", ");
  const noun = toolNames.length === 1 ? "tool is" : "tools are";
  return (
    `The following ${noun} not available with the current model and ` +
    `has been removed: ${list}. Proceed using the remaining tools or your ` +
    `training knowledge.`
  );
}

function buildEmptyResponseNudge(error: EmptyModelResponseError): string {
  const tail = error.reasoningTail?.trim();
  if (error.finishReason === "length" && tail) {
    return (
      "Your previous step hit the output length limit while reasoning before emitting a tool call or reply. " +
      "Where your reasoning left off:\n" +
      `${tail}\n` +
      "Take your next concrete tool call or give your final answer immediately without repeating your earlier analysis. " +
      "Do not repeat writes or other side effects that already completed. Do not mention this notice."
    );
  }
  if (tail) {
    return (
      "Your previous reply had reasoning but no message and no tool call, so nothing was delivered. " +
      "Where your reasoning left off:\n" +
      `${tail}\n` +
      "Act on it now with a tool call or final answer. " +
      "Do not repeat writes or other side effects that already completed. Do not mention this notice."
    );
  }
  return EMPTY_RESPONSE_NUDGE;
}

export function isEmptyModelResponse(step: HarnessStepResult): boolean {
  return (
    step.toolCalls.length === 0 &&
    step.toolResults.length === 0 &&
    resolveAssistantStepText(step.response.messages, step.text) === null
  );
}

export function rethrowNoOutputAsEmptyResponse(error: unknown): never {
  if (isNoOutputGeneratedError(error)) {
    throw new EmptyModelResponseError({ cause: error });
  }
  throw error;
}

const EMPTY_RESPONSE_NUDGE =
  "Your previous reply was empty and was not delivered. Continue the current user request. Reuse completed results when they satisfy the request. If existing results are stale or insufficient, use the appropriate read tools to get fresh results. Do not repeat writes or other side effects that already completed. Do not mention this notice.";
