import type { SystemModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { createFrameworkUserMessage, type UserModelMessage } from "#harness/messages.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import { authoredEvaluate, type ValueReaction } from "../reaction.js";
import { readReactionsState, slotsOf, writeReactionsState } from "../state.js";

interface Instruction {
  readonly role: "system" | "user";
  readonly content: string;
}

/**
 * A `defineDynamic()` in `agent/instructions/`. A system instruction is part of every model call
 * while its definition returns it; a user instruction joins the conversation when its content
 * changes, and stays there.
 */
export function instructionsReaction(resolver: ResolvedDynamicInstructionsResolver): ValueReaction {
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
    evaluate: authoredEvaluate(resolver.evaluate, { framework: resolver.framework }),
    label: resolver.logicalPath,
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
 * User instructions whose content differs from what their definition last added; records each
 * one's digest. A definition that returns `null`, or a system instruction, resets it, so the same
 * content returned later joins again. The digests outlive deployments: new code doesn't add the
 * same text again.
 */
export function takeUserInstructionMessages(ctx: AlsContext): UserModelMessage[] {
  const state = readReactionsState(ctx);
  const appended: Record<string, string> = { ...state.appended };
  const messages: UserModelMessage[] = [];
  let changed = false;
  for (const { id, slot } of slotsOf(ctx, "instructions")) {
    const instruction = slot.value as Instruction | null;
    if (instruction?.role !== "user") {
      if (appended[id] !== undefined) {
        delete appended[id];
        changed = true;
      }
      continue;
    }
    if (appended[id] === slot.digest) continue;
    appended[id] = slot.digest;
    changed = true;
    messages.push(createFrameworkUserMessage("context.instruction", instruction.content));
  }
  if (changed) writeReactionsState(ctx, { ...state, appended });
  return messages;
}
