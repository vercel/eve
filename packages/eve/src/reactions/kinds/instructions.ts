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

/**
 * The system instructions the session's slots hold, in run order. Where the harness says which
 * the model reads, the declared ones it keeps, then its own.
 */
export function dynamicInstructionMessages(
  ctx: Pick<ContextReader, "get"> | undefined,
): SystemModelMessage[] {
  const kept = keptInstructions(ctx);
  return slotsOf(ctx, "instructions").flatMap(({ id, slot }) => {
    const instruction = slot.value as Instruction | null;
    if (kept !== undefined && id !== HARNESS_INSTRUCTIONS && !kept.has(slugOf(id))) return [];
    return instruction?.role === "system" && instruction.content !== ""
      ? [{ content: instruction.content, role: "system" }]
      : [];
  });
}

/** The harness's instructions: its own content, and the declared instructions it keeps. */
export const HARNESS_INSTRUCTIONS = "instructions:@harness";

/** The declared instructions the harness keeps, where it says which; `agent` is the agent's. */
export function keptInstructions(
  ctx: Pick<ContextReader, "get"> | undefined,
): ReadonlySet<string> | undefined {
  const slot = slotsOf(ctx, "instructions").find(({ id }) => id === HARNESS_INSTRUCTIONS)?.slot;
  const keep = (slot?.value as { keep?: unknown } | null | undefined)?.keep;
  if (!Array.isArray(keep)) return undefined;
  return new Set(keep.filter((name): name is string => typeof name === "string"));
}

/** The slugs of the instructions the session's slots hold. */
export function dynamicInstructionSlugs(
  ctx: Pick<ContextReader, "get"> | undefined,
  options: { readonly except?: string } = {},
): readonly string[] {
  return slotsOf(ctx, "instructions")
    .filter(({ id }) => id !== options.except)
    .map(({ id }) => slugOf(id));
}

function slugOf(id: string): string {
  return id.slice("instructions:".length);
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
