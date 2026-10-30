import type { ModelMessage, SystemModelMessage } from "ai";

import { HistoryStateKey } from "#context/keys.js";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { harnessInstructions } from "#reactions/kinds/instructions.js";
import { nativeInstructions } from "#harness/policy/agent.js";
import { memoryRecallContents } from "#reactions/kinds/memory.js";
import { dynamicSkillManifest } from "#reactions/kinds/skill.js";
import { catalogAnnouncements } from "#execution/catalog/listing.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { dynamicSkillAnnouncements } from "#execution/skills/instructions.js";
import { createCurrentMessages } from "#harness/current-messages.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { applySystemCacheBreakpoint } from "#harness/prompt-cache.js";
import type { Step } from "#harness/step/context.js";

export type RequestMessages = ReturnType<typeof createCurrentMessages>;

/**
 * The messages one model call sends: the durable prompt, then the step's system instructions and
 * announcements. Announcements persist ahead of the new input, or after earlier tool results on a
 * continuation, or ahead of the turn's surviving input after a compaction, so later requests keep
 * the full prefix.
 */
export function requestMessages(
  step: Step,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly projectedMessages: readonly HarnessModelMessage[];
    readonly turnMessages: readonly HarnessModelMessage[];
    readonly catalog: StepCatalog;
    readonly pendingApprovalsNote: string | undefined;
  },
): RequestMessages {
  const { ctx } = step;
  const messages = createCurrentMessages(input.messages, {
    historyState: ctx?.get(HistoryStateKey),
    currentTurnMessages: input.turnMessages,
    projectedMessages: input.projectedMessages,
  });
  // eve announces what its catalog tools reach, wherever the step offers them.
  const { catalog } = input;
  const announced = ctx?.get(HistoryStateKey)?.announcements;
  const reachesCatalog = [CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME].some(catalog.allows);
  messages.addAnnouncements({
    ...(reachesCatalog && catalogAnnouncements(catalog, announced)),
    ...(catalog.allows(SKILL_TOOL_NAME) &&
      dynamicSkillAnnouncements(dynamicSkillManifest(ctx), announced)),
  });
  if (input.pendingApprovalsNote !== undefined) {
    messages.add(input.pendingApprovalsNote, "context.state", { cacheFriendly: false });
  }
  // Last, so nothing lands between a turn's recall and that turn's input.
  messages.addAnchored(memoryRecallContents(ctx), "memory.load");
  return messages;
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

/** The step's system prompt: the harness's, where it gives one; otherwise eve's default prompt. */
export function stepInstructions(
  step: Step,
  catalog: Pick<StepCatalog, "offersTasks">,
): string | readonly string[] {
  return (
    harnessInstructions(step.ctx) ??
    nativeInstructions(step.ctx, {
      finalReplyOnly: step.finalReplyOnly,
      offersTasks: catalog.offersTasks,
    })
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
