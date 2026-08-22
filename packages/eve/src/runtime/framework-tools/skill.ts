import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { AuthoredSkillsKey } from "#context/providers/skill-key.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { loadSkillFromSandbox } from "#runtime/skills/sandbox-access.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
export type LoadSkillInput = z.infer<typeof SKILL_INPUT_SCHEMA>;

/**
 * Executes the `load_skill` tool.
 *
 * Returns authored skill instructions directly from the resolved agent.
 * Active dynamic skills take precedence and remain sandbox-backed because
 * their full package content is currently materialized there at runtime.
 */
export async function executeLoadSkillTool(args: LoadSkillInput): Promise<unknown> {
  const ctx = loadContext();
  const authoredSkills = ctx.require(AuthoredSkillsKey);
  const { skill } = args;
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

export const SKILL_INPUT_SCHEMA = z.strictObject({
  skill: z.string().describe("Available skill name or id."),
});
export const SKILL_OUTPUT_SCHEMA = z.string();

export const loadSkillToolDefinition: ToolDefinition = {
  description: [
    "Load the full instructions for one available skill by name or id.",
    "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
    "Loading adds the skill instructions to the current turn.",
    'Choose the "skill" value from the Available skills block.',
  ].join(" "),
  execute: async (input) => executeLoadSkillTool(input as LoadSkillInput),
  inputSchema: SKILL_INPUT_SCHEMA,
  outputSchema: SKILL_OUTPUT_SCHEMA,
};

/**
 * Transitional runtime-catalog projection. Source-composed manifests replace
 * this entry by canonical path; legacy in-memory graph fixtures still use it.
 */
export const SKILL_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: loadSkillToolDefinition.description,
  execute: (input) => executeLoadSkillTool(input as LoadSkillInput),
  inputSchema: SKILL_INPUT_SCHEMA,
  logicalPath: "eve:framework/load-skill",
  name: "load_skill",
  outputSchema: SKILL_OUTPUT_SCHEMA,
  sourceId: "eve:load-skill-tool",
  sourceKind: "module",
};
