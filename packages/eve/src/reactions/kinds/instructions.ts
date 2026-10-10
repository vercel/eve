import type { SystemModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { createFrameworkUserMessage, type UserModelMessage } from "#harness/messages.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import type { Reaction } from "../reaction.js";
import { slotsOf } from "../runner.js";
import { readReactionsState, writeReactionsState } from "../state.js";

interface Instruction {
  readonly role: "system" | "user";
  readonly content: string;
}

/**
 * A `defineDynamic()` in `agent/instructions/`. A system instruction is part of every model call
 * while its slot holds it; a user instruction joins the conversation once, when a new selection
 * resolves to it.
 */
export function instructionsReaction(resolver: ResolvedDynamicInstructionsResolver): Reaction {
  return {
    contribute: (result) => {
      if (result === null || result === undefined) return { value: null };
      if (!isBrandedInstructionsEntry(result)) {
        throw new Error(
          `Dynamic instructions resolver "${resolver.slug}" returned an unbranded value — wrap with defineInstructions().`,
        );
      }
      const normalized = normalizeInstructionsDefinition(
        result as InstructionsDefinition,
        "Expected dynamic instructions to match the public eve shape.",
      );
      const content = normalized.content.trim();
      return {
        value: content.length === 0 ? null : { content, role: normalized.role ?? "system" },
      };
    },
    id: `instructions:${resolver.slug}`,
    kind: "instructions",
    label: resolver.logicalPath,
    resolve: resolver.resolve as Reaction["resolve"],
    ...(resolver.select === undefined ? {} : { select: resolver.select as Reaction["select"] }),
  };
}

/** The system instructions the session's slots hold, in run order. */
export function dynamicInstructionMessages(
  ctx: Pick<ContextReader, "get"> | undefined,
): SystemModelMessage[] {
  return slotsOf(ctx, "instructions").flatMap(({ slot }) => {
    const instruction = slot.value as Instruction | null;
    return instruction?.role === "system" ? [{ content: instruction.content, role: "system" }] : [];
  });
}

/** User instructions whose slots changed since the conversation last took them; marks them taken. */
export function takeUserInstructionMessages(ctx: AlsContext): UserModelMessage[] {
  const state = readReactionsState(ctx);
  const appended = { ...state.appended };
  const messages: UserModelMessage[] = [];
  for (const { id, slot } of slotsOf(ctx, "instructions")) {
    const instruction = slot.value as Instruction | null;
    if (instruction?.role !== "user" || (appended[id] ?? -1) >= slot.since) continue;
    appended[id] = slot.since;
    messages.push(createFrameworkUserMessage("context.instruction", instruction.content));
  }
  if (messages.length > 0) writeReactionsState(ctx, { ...state, appended });
  return messages;
}
