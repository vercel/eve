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
  readonly anthropicCache: ModelProfile["anthropicCache"];
  readonly extraSystemNote?: string;
}): SystemModelMessage | string | undefined {
  const note = input.extraSystemNote ? [input.extraSystemNote] : [];
  if (typeof input.instructions === "string" && note.length === 0) return input.instructions;
  const parts = [
    ...note,
    ...(typeof input.instructions === "string" ? [input.instructions] : input.instructions),
  ].filter((part) => part !== "");
  const instructions = parts.map((content): SystemModelMessage => ({ content, role: "system" }));
  return mergeSystemInstructions(
    input.anthropicCache
      ? applySystemCacheBreakpoint(instructions, input.anthropicCache)
      : instructions,
  );
}

export function withTrailingUserNote(
  messages: readonly ModelMessage[],
  note?: string,
): ModelMessage[] {
  return note ? [...messages, createFrameworkUserMessage("execution.retry", note)] : [...messages];
}

export function mergeSystemInstructions(
  instructions: readonly SystemModelMessage[],
): SystemModelMessage | undefined {
  if (instructions.length === 0) {
    return undefined;
  }

  if (instructions.length === 1) {
    return { ...instructions[0]! };
  }

  let providerOptions: SystemModelMessage["providerOptions"] | undefined;
  for (const instruction of instructions) {
    if (instruction.providerOptions !== undefined) {
      providerOptions = {
        ...providerOptions,
        ...instruction.providerOptions,
      };
    }
  }

  const merged: SystemModelMessage = {
    role: "system",
    content: instructions.map((instruction) => instruction.content).join("\n\n"),
  };
  if (providerOptions !== undefined) {
    merged.providerOptions = providerOptions;
  }
  return merged;
}
