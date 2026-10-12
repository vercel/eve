import type { SystemModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { createFrameworkUserMessage, type UserModelMessage } from "#harness/messages.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import { authoredRender, authoredRecord, type Reaction } from "../reaction.js";
import { slotsOf } from "../state.js";
import { readReactionsState, writeReactionsState } from "../state.js";

interface Instruction {
  readonly role: "system" | "user";
  readonly content: string;
}

/**
 * A `defineDynamic()` in `agent/instructions/`. A system instruction is part of every model call
 * while its slot holds it; a user instruction joins the conversation once per occurrence, and
 * stays there.
 */
export function instructionsReaction(resolver: ResolvedDynamicInstructionsResolver): Reaction {
  return {
    contribute: (result) => {
      if (result === null || result === undefined) return { value: null };
      if (!isBrandedInstructionsEntry(result)) {
        throw new Error(
          `The dynamic instructions "${resolver.slug}" returned an unbranded value — wrap with defineInstructions().`,
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
    render: authoredRender(resolver.logicalPath, resolver.render, {
      framework: resolver.framework,
    }),
    record: authoredRecord(resolver.logicalPath, resolver.record, {
      framework: resolver.framework,
    }),
    select: resolver.select as Reaction["select"],
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

/**
 * User instructions from occurrences the conversation hasn't taken yet; marks them taken. Each
 * occurrence that returns one adds it once, even when its text matches the last one's, and a
 * retried occurrence adds nothing new.
 */
export function takeUserInstructionMessages(ctx: AlsContext): UserModelMessage[] {
  const state = readReactionsState(ctx);
  const appended = { ...state.appended };
  const messages: UserModelMessage[] = [];
  let changed = false;
  for (const { id, slot } of slotsOf(ctx, "instructions")) {
    const occurrence = slot.occurrence ?? 1;
    if ((appended[id] ?? 0) >= occurrence) continue;
    appended[id] = occurrence;
    changed = true;
    const instruction = slot.value as Instruction | null;
    if (instruction?.role !== "user") continue;
    messages.push(createFrameworkUserMessage("context.instruction", instruction.content));
  }
  if (changed) writeReactionsState(ctx, { ...state, appended });
  return messages;
}
