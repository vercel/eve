import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { AlsContext } from "#context/container.js";
import type { Announcement } from "#harness/announcements.js";
import { digestOf } from "#definitions/state.js";
import { agentInstructionsOf, renderInstructionsBlock } from "#runtime/prompt/compose.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import { authoredEvaluate, type Definition, section, SECTION_ORDER } from "./definition.js";

type Instruction = { readonly role: "system" | "user"; readonly content: string };

/**
 * The agent's static instructions: its system instructions as one block of eve's default prompt,
 * and its user instructions announced, as dynamic ones are.
 */
export const instructions: Definition = {
  contribute: ({ container }) => ({
    announcements: () =>
      Object.fromEntries(
        staticUserInstructions(container).map(({ content, key }) => [
          key,
          userInstruction(content, digestOf(content)),
        ]),
      ),
    system: () => {
      const block = agentInstructionsOf(compiledBundleOf(container)?.resolvedAgent.instructions);
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
      const spec = compiledBundleOf(container)?.turnAgent?.workspaceSpec;
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
 * prompt of its own while its definition returns it; a user instruction is announced: it joins the
 * conversation when its content changes, and stays there.
 */
export function instructionsDefinition(
  resolver: ResolvedDynamicDefinition<"instructions">,
): Definition {
  const id = `instructions:${resolver.slug}`;
  const evaluate = authoredEvaluate(resolver.evaluate);
  return {
    contribute: (ctx) => {
      const kept = async () =>
        await ctx.keep(async (evaluation) => ({
          value: instructionOf(resolver, await evaluate(evaluation)),
        }));
      return {
        announcements: async () => {
          const value = (await kept())?.value;
          if (value === undefined) return {};
          const instruction = value as Instruction | null;
          return {
            [id]: userInstruction(
              instruction?.role === "user" ? instruction.content : undefined,
              digestOf(value),
            ),
          };
        },
        system: async () => {
          const instruction = (await kept())?.value as Instruction | null | undefined;
          return instruction?.role === "system" && instruction.content !== ""
            ? [
                section(id, instruction.content, {
                  order: SECTION_ORDER.dynamicInstructions,
                  part: "own",
                }),
              ]
            : [];
        },
      };
    },
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
 * A user instruction, announced under its digest, which the same content repeats. Without content
 * the key forgets it, so the same content returned later joins again.
 */
function userInstruction(content: string | undefined, digest: string): Announcement {
  return {
    initial: "",
    kind: "context.instruction",
    render: () => content,
    value: content === undefined ? "" : digest,
  };
}

/** The agent's static user instructions, each under its announcement's key. */
export function staticUserInstructions(
  container: Pick<AlsContext, "get">,
): readonly { readonly key: string; readonly content: string }[] {
  return (compiledBundleOf(container)?.resolvedAgent.instructions ?? []).flatMap((entry) => {
    const content = entry.content.trim();
    return entry.role === "user" && content.length > 0
      ? [{ content, key: `eve.instructions:${entry.name}` }]
      : [];
  });
}
