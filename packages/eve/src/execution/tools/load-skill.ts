import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { loadSkillFromSandbox } from "#runtime/skills/sandbox-access.js";

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
type LoadSkillInput = z.infer<typeof SKILL_INPUT_SCHEMA>;

/**
 * Executes the `load_skill` tool.
 *
 * Returns authored skill instructions directly from the resolved agent.
 * Active dynamic skills take precedence and remain sandbox-backed because
 * their full package content is currently materialized there at runtime.
 */
async function executeLoadSkillTool(args: LoadSkillInput): Promise<unknown> {
  const ctx = loadContext();
  const { skill } = args;
  const authoredSkills = ctx.require(BundleKey).resolvedAgent.skills;
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

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const SKILL_INPUT_SCHEMA = z.strictObject({
  skill: z.string().describe("Available skill name or id."),
});
export const SKILL_OUTPUT_SCHEMA = z.string();

export async function executeLoadSkill(input: unknown): Promise<unknown> {
  return await executeLoadSkillTool(input as LoadSkillInput);
}
