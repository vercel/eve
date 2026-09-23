import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { stripSkillFrontmatter } from "#shared/skill-package.js";

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
type LoadSkillInput = z.infer<typeof SKILL_INPUT_SCHEMA>;

/**
 * Executes the `load_skill` tool.
 *
 * Returns instructions from memory without a sandbox: authored skills from the
 * resolved agent and dynamic skills from durable context. Dynamic skills take
 * precedence over authored skills with the same name.
 */
async function executeLoadSkillTool(args: LoadSkillInput): Promise<unknown> {
  const ctx = loadContext();
  const { skill } = args;
  const dynamicSkills = Object.values(ctx.get(DynamicSkillManifestKey) ?? {}).flat();
  const authoredSkills = ctx.require(BundleKey).resolvedAgent.skills;
  const dynamicSkill = dynamicSkills.find((entry) => entry.name === skill);
  if (dynamicSkill !== undefined) return stripSkillFrontmatter(dynamicSkill.markdown);
  const authoredSkill = authoredSkills.find((entry) => entry.name === skill);
  if (authoredSkill !== undefined) return authoredSkill.markdown;

  const availableSkills = [
    ...new Set([...dynamicSkills, ...authoredSkills].map((entry) => entry.name)),
  ].sort();
  const message = formatSkillNotFoundError(skill, availableSkills);
  const connectionName = ctx
    .get(ConnectionRegistryKey)
    ?.getConnectionNames()
    .find((name) => name.toLowerCase() === skill.toLowerCase());
  if (connectionName === undefined) throw new Error(message);

  throw new Error(
    `${message} "${connectionName}" is an installed connection, not a skill. ` +
      `Use connection_search with connection "${connectionName}" to find its tools.`,
  );
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
