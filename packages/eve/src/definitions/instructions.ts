import type { AlsContext } from "#context/container.js";
import { createFrameworkUserMessage, type UserModelMessage } from "#harness/messages.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import { readDefinitionsState, slotsOf, writeDefinitionsState } from "#definitions/state.js";
import { agentInstructionsOf, renderInstructionsBlock } from "#runtime/prompt/compose.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import { authoredEvaluate, type Definition, section, SECTION_ORDER } from "./definition.js";

type Instruction = { readonly role: "system" | "user"; readonly content: string };

/** The agent's static system instructions, as one block of eve's default prompt. */
export const instructions: Definition = {
  contribute: ({ container }) => ({
    system: () => {
      const block = agentInstructionsOf(container.get(BundleKey)?.resolvedAgent.instructions);
      return [
        section("eve.instructions", block === undefined ? "" : renderInstructionsBlock(block), {
          order: SECTION_ORDER.instructions,
        }),
      ];
    },
  }),
  id: "eve.instructions",
  label: "the agent's instructions",
};

/** What the agent's workspace holds, where it has one. */
export const workspace: Definition = {
  contribute: ({ container }) => ({
    system: () => {
      const spec = container.get(BundleKey)?.turnAgent?.workspaceSpec;
      const text = spec === undefined ? undefined : createWorkspacePromptSection(spec);
      return text === undefined
        ? []
        : [section("eve.workspace", text, { order: SECTION_ORDER.workspace })];
    },
  }),
  id: "eve.workspace",
  label: "the agent's workspace",
};

/**
 * A `defineDynamic()` in `agent/instructions/`. A system instruction is a part of the system
 * prompt of its own while its definition returns it; a user instruction joins the conversation
 * when its content changes, and stays there.
 */
export function instructionsDefinition(
  resolver: ResolvedDynamicDefinition<"instructions">,
): Definition {
  const id = `instructions:${resolver.slug}`;
  const evaluate = authoredEvaluate(resolver.evaluate);
  return {
    contribute: (ctx) => ({
      system: async () => {
        const kept = await ctx.keep(async (evaluation) => ({
          value: instructionOf(resolver, await evaluate(evaluation)),
        }));
        const instruction = kept?.value as Instruction | null | undefined;
        return instruction?.role === "system" && instruction.content !== ""
          ? [
              section(id, instruction.content, {
                order: SECTION_ORDER.dynamicInstructions,
                part: "own",
              }),
            ]
          : [];
      },
    }),
    id,
    label: resolver.logicalPath,
  };
}

function instructionOf(
  resolver: ResolvedDynamicDefinition<"instructions">,
  result: unknown,
): Instruction | null {
  if (result === null || result === undefined) return null;
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
  return content.length === 0 ? null : { content, role: normalized.role ?? "system" };
}

/**
 * User instructions whose content differs from what their definition last added; records each
 * one's digest. A definition that returns `null`, or a system instruction, resets it, so the same
 * content returned later joins again. The digests outlive deployments: new code doesn't add the
 * same text again.
 */
export function takeUserInstructionMessages(ctx: AlsContext): UserModelMessage[] {
  const state = readDefinitionsState(ctx);
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
  if (changed) writeDefinitionsState(ctx, { ...state, appended });
  return messages;
}
