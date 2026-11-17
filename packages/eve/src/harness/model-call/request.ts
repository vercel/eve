import type { ModelMessage, SystemModelMessage } from "ai";

import type { HistoryState } from "#context/keys.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { applySystemCacheBreakpoint } from "#harness/prompt-cache.js";

export interface RequestMessages {
  readonly history: readonly HarnessModelMessage[];
  readonly historyState: HistoryState;
  readonly nonSystemMessages: readonly HarnessModelMessage[];
}

export function modelInstructions(input: {
  readonly instructions: string | readonly string[];
  readonly profile: Pick<ModelProfile, "anthropicCache" | "gateway" | "provider">;
  readonly extraSystemNote?: string;
}): SystemModelMessage | SystemModelMessage[] | string | undefined {
  const { anthropicCache, gateway, provider } = input.profile;
  const [base = "", ...own] =
    typeof input.instructions === "string" ? [input.instructions] : input.instructions;
  const note = input.extraSystemNote ?? "";

  const gatewayAnchorsFirstMessage = gateway && provider === "anthropic";
  if (anthropicCache === undefined && typeof input.instructions === "string" && note === "") {
    return input.instructions;
  }
  if (anthropicCache === undefined && !gatewayAnchorsFirstMessage) {
    return systemMessage([note, base, ...own]);
  }

  const baseMessage = systemMessage([base]);
  const ownMessage = systemMessage([note, ...own]);
  const messages = [
    ...(baseMessage === undefined
      ? []
      : anthropicCache
        ? applySystemCacheBreakpoint([baseMessage], anthropicCache)
        : [baseMessage]),
    ...(ownMessage === undefined ? [] : [ownMessage]),
  ];
  return messages.length > 1 ? messages : messages[0];
}

function systemMessage(parts: readonly string[]): SystemModelMessage | undefined {
  const content = parts.filter((part) => part !== "").join("\n\n");
  return content === "" ? undefined : { role: "system", content };
}

export function withTrailingUserNote(
  messages: readonly ModelMessage[],
  note?: string,
): ModelMessage[] {
  return note ? [...messages, createFrameworkUserMessage("execution.retry", note)] : [...messages];
}
