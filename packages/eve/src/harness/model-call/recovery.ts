import { createLogger } from "#internal/logging.js";
import {
  EmptyModelResponseError,
  extractUnsupportedProviderToolTypes,
  isNoOutputGeneratedError,
} from "#harness/model-call/errors.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { resolveAssistantStepText } from "#harness/messages.js";
import { resolveFrameworkToolFromUpstreamType } from "#harness/provider-tools.js";

import type { ModelCallOptions } from "./call.js";

const log = createLogger("harness.tool-loop");

export function recoverModelCall(
  error: unknown,
  options: ModelCallOptions,
  diagnostics: { readonly sessionId: string; readonly turnId: string },
): ModelCallOptions | undefined {
  if (options.retryReason !== undefined) return undefined;
  if (options.disabledProviderTools === undefined) {
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
        disabledProviderTools: new Set(disabled),
        extraSystemNote: buildDisabledToolNote(disabled),
      };
    }
  }
  if (!(error instanceof EmptyModelResponseError)) return undefined;
  log.warn("empty model response; reissuing the model call once", diagnostics);
  return { ...options, retryReason: "empty-response", trailingUserNote: EMPTY_RESPONSE_NUDGE };
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
