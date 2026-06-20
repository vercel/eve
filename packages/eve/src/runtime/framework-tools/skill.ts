import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { loadSkillFromSandbox } from "#runtime/skills/sandbox-access.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
interface LoadSkillInput {
  readonly skill: string;
}

/**
 * Executes the `load_skill` tool.
 *
 * Reads the requested skill's `SKILL.md` from the active sandbox and
 * returns it as the tool result.
 */
async function executeLoadSkillTool(args: LoadSkillInput): Promise<unknown> {
  const ctx = loadContext();
  const sandbox = ctx.get(SandboxKey);

  if (sandbox === undefined) {
    throw new Error(
      "The load_skill tool requires sandbox access on the runtime context. " +
        "Ensure the step is running inside a managed runtime context with sandbox support.",
    );
  }

  const { skill } = args;
  return await loadSkillFromSandbox(sandbox, skill, availableSkillNames(ctx));
}

/**
 * The runtime-contributed (dynamic) skill names the model was shown, used to
 * help it correct a wrong id — e.g. calling `talk-like-a-dog` when the loadable
 * id is `custom__talk-like-a-dog`. Dynamic skills are the ones whose names are
 * qualified at runtime (`slug__key`); authored skills already appear verbatim in
 * the static "Available skills" prompt section, so they are not repeated here.
 *
 * Reads only `#context/keys.js`: a framework tool must not import heavy session
 * modules (e.g. for the bundle), which would create an import cycle through the
 * framework-tools barrel. Best-effort — an absent manifest yields no hint rather
 * than masking the underlying "skill not found" error.
 */
function availableSkillNames(ctx: ReturnType<typeof loadContext>): string[] {
  const dynamic = Object.values(ctx.get(DynamicSkillManifestKey) ?? {})
    .flat()
    .map((s) => s.name);
  return [...new Set(dynamic)].sort();
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const SKILL_OUTPUT_SCHEMA: JsonObject = { type: "string" };

export const SKILL_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Load the full instructions for one available skill by name or id.",
    "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
    "Loading adds the skill instructions to the current turn.",
    'Choose the "skill" value from the Available skills block.',
  ].join(" "),
  execute: (input) => executeLoadSkillTool(input as LoadSkillInput),
  inputSchema: {
    additionalProperties: false,
    properties: {
      skill: {
        description: "Available skill name or id.",
        type: "string",
      },
    },
    required: ["skill"],
    type: "object",
  },
  logicalPath: "eve:framework/load-skill",
  name: "load_skill",
  outputSchema: SKILL_OUTPUT_SCHEMA,
  sourceId: "eve:load-skill-tool",
  sourceKind: "module",
};
