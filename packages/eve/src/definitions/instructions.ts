import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { AlsContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import type { Announcement } from "#harness/announcements.js";
import { digestOf } from "#definitions/state.js";
import { agentInstructionsOf, renderInstructionsBlock } from "#runtime/prompt/compose.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import {
  authoredEvaluate,
  type Definition,
  type DefinitionContext,
  section,
  SECTION_ORDER,
} from "./definition.js";
import { owningSandboxProviderOf } from "./skills.js";

type Instruction = { readonly role: "system" | "user"; readonly content: string };

const SANDBOX_TOOL_NAMES = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
]);

const STATIC_WORKSPACE_ROOT_PROVIDERS = new Set(["default", "docker", "just-bash", "vercel"]);

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

export const workspace: Definition = {
  contribute: (ctx) => ({
    arrange: (draft) => ({
      system: async () => {
        const existing = await draft.system();
        const spec = compiledBundleOf(ctx.container)?.turnAgent?.workspaceSpec;
        const workspaceText = spec === undefined ? undefined : createWorkspacePromptSection(spec);
        const tools = await draft.tools();
        const hasSandboxTool = [...tools.entries.keys()].some((name) =>
          SANDBOX_TOOL_NAMES.has(name),
        );
        const cwd = hasSandboxTool ? await resolveWorkingDirectory(ctx) : undefined;
        const parts = [
          ...(cwd === undefined ? [] : [`Current working directory: ${cwd}`]),
          ...(workspaceText === undefined ? [] : [workspaceText]),
        ];
        return parts.length === 0
          ? existing
          : [
              ...existing,
              section("eve.workspace", parts.join("\n\n"), { order: SECTION_ORDER.workspace }),
            ];
      },
    }),
  }),
  id: "eve.workspace",
  label: "the agent's workspace",
};

async function resolveWorkingDirectory(ctx: DefinitionContext): Promise<string | undefined> {
  const provider = owningSandboxProviderOf(ctx.container);
  if (provider === undefined) return undefined;
  if (STATIC_WORKSPACE_ROOT_PROVIDERS.has(provider)) return WORKSPACE_ROOT;
  if (provider !== "host") return undefined;
  const kept = await ctx.keep(async (_evaluation, previous) => {
    if (typeof previous === "string") return { value: previous };
    try {
      const sandbox = await ctx.container.get(SandboxKey)?.get();
      return sandbox == null ? null : { value: sandbox.resolvePath(".") };
    } catch {
      return null;
    }
  });
  return typeof kept?.value === "string" ? kept.value : undefined;
}

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

function userInstruction(content: string | undefined, digest: string): Announcement {
  return {
    initial: "",
    kind: "context.instruction",
    render: () => content,
    value: content === undefined ? "" : digest,
  };
}

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
