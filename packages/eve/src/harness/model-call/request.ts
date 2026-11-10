import type { ModelMessage, SystemModelMessage } from "ai";

import type { HistoryState } from "#context/keys.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { applySystemCacheBreakpoint } from "#harness/prompt-cache.js";

/** One model call's messages: what the step commits, and what the model reads. */
export interface RequestMessages {
  readonly history: readonly HarnessModelMessage[];
  readonly historyState: HistoryState;
  readonly nonSystemMessages: readonly HarnessModelMessage[];
}

/**
 * The call's system prompt: `instructions` is one string, or the base part followed by the own
 * parts. A model that caches by message prefix gets the base as a message of its own, then the
 * retry's note and the own parts as a second message, so sessions whose own parts differ still
 * share the base. The base carries eve's breakpoint, or, on Gateway's automatic caching, the one
 * Gateway anchors on the first message. Any other model gets one system message, a string alone
 * as it is.
 */
export function modelInstructions(input: {
  readonly instructions: string | readonly string[];
  readonly profile: Pick<ModelProfile, "anthropicCache" | "gateway" | "provider">;
  readonly extraSystemNote?: string;
}): SystemModelMessage | SystemModelMessage[] | string | undefined {
  const { anthropicCache, gateway, provider } = input.profile;
  const [base = "", ...own] =
    typeof input.instructions === "string" ? [input.instructions] : input.instructions;
  const note = input.extraSystemNote ?? "";
  if (anthropicCache === undefined && typeof input.instructions === "string" && note === "") {
    return input.instructions;
  }
  if (anthropicCache === undefined && !(gateway && provider === "anthropic")) {
    return systemMessage([note, base, ...own]);
  }
  const rest = systemMessage([note, ...own]);
  const first = base === "" ? undefined : systemMessage([base]);
  const messages = [
    ...(first === undefined
      ? []
      : anthropicCache
        ? applySystemCacheBreakpoint([first], anthropicCache)
        : [first]),
    ...(rest === undefined ? [] : [rest]),
  ];
  return messages.length > 1 ? messages : messages[0];
}

/** The parts joined into one system message, empty ones skipped, or nothing if none is left. */
function systemMessage(parts: readonly string[]): SystemModelMessage | undefined {
  const content = parts.filter((part) => part !== "").join("\n\n");
  return content === "" ? undefined : { role: "system", content };
}

/** A retry's note, trailing the call's messages. */
export function withTrailingUserNote(
  messages: readonly ModelMessage[],
  note?: string,
): ModelMessage[] {
  return note ? [...messages, createFrameworkUserMessage("execution.retry", note)] : [...messages];
}
