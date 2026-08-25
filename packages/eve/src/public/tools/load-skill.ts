import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { SkillCatalogKey } from "#context/providers/skill-catalog-key.js";
import { defineTool } from "#public/definitions/tool.js";
import { loadSkillFromSandbox } from "#runtime/skills/sandbox-access.js";

/**
 * Input schema for the framework `load_skill` tool. Single source of truth so
 * model input contracts stay in sync without duplication.
 */
export const SKILL_INPUT_SCHEMA = z.strictObject({
  skill: z.string().describe("Available skill name or id."),
});

/**
 * Output schema for the framework `load_skill` tool.
 */
export const SKILL_OUTPUT_SCHEMA = z.string();

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
export type LoadSkillInput = z.infer<typeof SKILL_INPUT_SCHEMA>;

/**
 * Executes the `load_skill` tool.
 *
 * Returns authored skill instructions directly from the active node's skill
 * catalog on the runtime context. Active dynamic skills take precedence and
 * remain sandbox-backed because their full package content is currently
 * materialized there at runtime.
 */
export async function executeLoadSkillTool(args: LoadSkillInput): Promise<string> {
  const ctx = loadContext();
  const { skill } = args;
  const authoredSkills = ctx.get(SkillCatalogKey) ?? [];
  const dynamicSkillNames = availableDynamicSkillNames(ctx);
  const availableSkills = [
    ...new Set([...authoredSkills.map((entry) => entry.name), ...dynamicSkillNames]),
  ].sort();

  try {
    if (dynamicSkillNames.includes(skill)) {
      const sandbox = ctx.get(SandboxKey);
      if (sandbox === undefined) {
        throw new Error(
          `The dynamic skill "${skill}" requires sandbox access on the runtime context.`,
        );
      }
      return await loadSkillFromSandbox(sandbox, skill, availableSkills);
    }

    const authoredSkill = authoredSkills.find((entry) => entry.name === skill);
    if (authoredSkill !== undefined) {
      return authoredSkill.markdown;
    }

    throw new Error(formatSkillNotFoundError(skill, availableSkills));
  } catch (error) {
    const connectionName = ctx
      .get(ConnectionRegistryKey)
      ?.getConnectionNames()
      .find((name) => name.toLowerCase() === skill.toLowerCase());
    if (connectionName === undefined || availableSkills.includes(skill)) throw error;

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} "${connectionName}" is an installed connection, not a skill. ` +
        `Use connection_search with connection "${connectionName}" to find its tools.`,
      { cause: error },
    );
  }
}

function availableDynamicSkillNames(ctx: ReturnType<typeof loadContext>): string[] {
  const dynamic = Object.values(ctx.get(DynamicSkillManifestKey) ?? {})
    .flat()
    .map((entry) => entry.name);
  return [...new Set(dynamic)].sort();
}

function formatSkillNotFoundError(skill: string, availableSkills: readonly string[]): string {
  const hint =
    availableSkills.length > 0 ? ` Available skills: ${availableSkills.join(", ")}.` : "";
  return `No skill named "${skill}".${hint}`;
}

/**
 * Framework `load_skill` tool: returns a named authored skill's instructions
 * directly; dynamic skills remain sandbox-backed. Import from
 * `eve/tools/load_skill` to spread, wrap, or re-export it from
 * `agent/tools/load_skill.ts`.
 */
export default defineTool({
  description: [
    "Load the full instructions for one available skill by name or id.",
    "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
    "Loading adds the skill instructions to the current turn.",
    'Choose the "skill" value from the Available skills block.',
  ].join(" "),
  inputSchema: SKILL_INPUT_SCHEMA,
  outputSchema: SKILL_OUTPUT_SCHEMA,
  execute: async (input) => executeLoadSkillTool(input as LoadSkillInput),
});
