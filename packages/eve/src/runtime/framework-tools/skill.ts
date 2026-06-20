import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { loadSkillFromSandbox } from "#runtime/skills/sandbox-access.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
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
 * The skill names the model was shown in the "Available skills" section:
 * authored skills plus every entry the dynamic skill manifest last produced.
 * Best-effort — a missing bundle or manifest yields fewer names rather than
 * masking the underlying "skill not found" error.
 */
function availableSkillNames(ctx: ReturnType<typeof loadContext>): string[] {
  const authored = ctx.get(BundleKey)?.resolvedAgent.skills.map((s) => s.name) ?? [];
  const dynamic = Object.values(ctx.get(DynamicSkillManifestKey) ?? {})
    .flat()
    .map((s) => s.name);
  return [...new Set([...authored, ...dynamic])].sort();
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
