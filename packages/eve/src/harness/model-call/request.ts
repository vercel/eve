import type { ModelMessage, SystemModelMessage } from "ai";

import { buildDynamicInstructionMessages } from "#context/dynamic-instruction-lifecycle.js";
import { DynamicSkillManifestKey, HistoryStateKey } from "#context/keys.js";
import { catalogAnnouncements } from "#execution/catalog/listing.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { dynamicSkillAnnouncements } from "#execution/skills/instructions.js";
import { taskSystemMessages } from "#execution/tasks/model-step.js";
import { createCurrentMessages } from "#harness/current-messages.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  type UserModelMessage,
} from "#harness/messages.js";
import { type AnthropicCacheMarker, applySystemCacheBreakpoint } from "#harness/prompt-cache.js";
import type { Step } from "#harness/step/context.js";
import type { HarnessSession } from "#harness/types.js";

export type RequestMessages = ReturnType<typeof createCurrentMessages>;

/**
 * The messages one model call sends: the durable prompt, then the step's system instructions and
 * announcements. Announcements persist ahead of the new input, or after earlier tool results on a
 * continuation, so later requests keep the full prefix.
 */
export function requestMessages(
  step: Step,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly projectedMessages: readonly HarnessModelMessage[];
    readonly turnMessages: readonly UserModelMessage[];
    readonly catalog: StepCatalog;
    readonly hidesHeldText: boolean;
    readonly pendingApprovalsNote: string | undefined;
  },
): RequestMessages {
  const { ctx } = step;
  const messages = createCurrentMessages(input.messages, {
    historyState: ctx?.get(HistoryStateKey),
    currentTurnMessages: input.turnMessages,
    projectedMessages: input.projectedMessages,
  });
  if (ctx !== undefined) messages.addSystem(buildDynamicInstructionMessages(ctx));
  messages.addSystem(
    taskSystemMessages(input.catalog.offersTasks, { finalReplyOnly: input.hidesHeldText }),
  );
  const announced = ctx?.get(HistoryStateKey)?.announcements;
  messages.addAnnouncements({
    ...catalogAnnouncements(input.catalog, announced),
    ...dynamicSkillAnnouncements(ctx?.get(DynamicSkillManifestKey), announced),
  });
  if (input.pendingApprovalsNote !== undefined) {
    messages.add(input.pendingApprovalsNote, "context.state", { cacheFriendly: false });
  }
  return messages;
}

/** The call's system instructions: a retry's note, the agent's system prompt, then the step's. */
export function modelInstructions(input: {
  readonly session: HarnessSession;
  readonly systemMessages: readonly SystemModelMessage[];
  readonly marker: AnthropicCacheMarker | undefined;
  readonly extraSystemNote?: string;
}): SystemModelMessage | string | undefined {
  const { session } = input;
  const extra: SystemModelMessage[] = input.extraSystemNote
    ? [{ role: "system", content: input.extraSystemNote }]
    : [];
  if (input.systemMessages.length === 0 && extra.length === 0) {
    return session.agent.system ?? undefined;
  }
  const base: SystemModelMessage[] = session.agent.system
    ? [{ role: "system", content: session.agent.system }]
    : [];
  const instructions = [...extra, ...base, ...input.systemMessages];
  return mergeSystemInstructions(
    input.marker ? applySystemCacheBreakpoint(instructions, input.marker) : instructions,
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
