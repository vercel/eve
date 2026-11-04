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
 * The call's system prompt: a retry's note, then exactly the instructions. A string alone is sent
 * as it is; parts join into one system message, empty ones skipped, with the cache breakpoint at
 * its end.
 */
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

/** A retry's note, trailing the call's messages. */
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
