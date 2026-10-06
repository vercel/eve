/**
 * Skills in the catalog. Every skill the session can see loads through
 * `execute({ skill })`, deferred or not. The call resolves to one loader entry
 * whose name sits outside the tool namespace, because skills and tools have
 * separate names.
 */

import type { ContextReader } from "#context/key.js";
import { DynamicSkillManifestKey } from "#context/keys.js";
import { skillFilePath } from "#execution/skills/instructions.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { displayTitle } from "#shared/display-name.js";
import { skillTarget } from "#shared/action-request-name.js";
import { stripSkillFrontmatter } from "#shared/skill-package.js";
import { toInputSchema } from "#tools/schema.js";

import { closestNames } from "./rank.js";

/** A skill the session can load. */
export interface CatalogSkill {
  readonly deferred: boolean;
  readonly description: string;
  /** The instructions loading returns. */
  readonly markdown: string;
  readonly name: string;
  /** The skill's `SKILL.md` under the skills root, when it has package files. */
  readonly path?: string;
}

/** The session's skills by name; a dynamic skill overrides a same-named authored one. */
export function sessionSkills(ctx: ContextReader | undefined): ReadonlyMap<string, CatalogSkill> {
  const skills = new Map<string, CatalogSkill>();
  for (const skill of ctx?.get(BundleKey)?.resolvedAgent.skills ?? []) {
    skills.set(skill.name, {
      deferred: skill.deferred === true,
      description: skill.description,
      markdown: skill.markdown,
      name: skill.name,
      path: skillFilePath(skill.name),
    });
  }
  for (const skill of Object.values(ctx?.get(DynamicSkillManifestKey) ?? {}).flat()) {
    skills.set(skill.name, {
      deferred: skill.deferred === true,
      description: skill.description,
      markdown: stripSkillFrontmatter(skill.markdown),
      name: skill.name,
      path: skill.revision === undefined ? undefined : skillFilePath(skill.name),
    });
  }
  return skills;
}

/** The entry every `execute({ skill })` call resolves to. */
export function createSkillLoader(
  skills: ReadonlyMap<string, CatalogSkill>,
): HarnessToolDefinition {
  return {
    description: "Loads a skill's instructions.",
    execute: (input: { readonly skill: string }) => {
      const skill = skills.get(input.skill);
      // `execute` validation resolves every skill before the call runs.
      if (skill === undefined) throw new Error(`No skill named "${input.skill}".`);
      return skill.markdown;
    },
    frameworkTool: true,
    inputSchema: SKILL_INPUT_SCHEMA,
    label: { start: skillLoadLabel },
    name: SKILL_ENTRY_NAME,
  };
}

function skillLoadLabel(input: unknown): string {
  const skill = skillTarget(input);
  return skill === undefined ? "Load skill" : `Load skill: ${displayTitle(skill)}`;
}

/** Why `execute` can't load `name`: the closest skills, or the connection it names. */
export function unknownSkillMessage(
  name: string,
  skills: ReadonlyMap<string, CatalogSkill>,
  connections: readonly string[],
): string {
  const suggestions = closestNames(name, [...skills.values()]);
  const hint =
    suggestions.length > 0
      ? ` Closest skills: ${suggestions.join(", ")}.`
      : " Find skills with search.";
  const connection = connections.find(
    (connectionName) => connectionName.toLowerCase() === name.toLowerCase(),
  );
  const connectionHint =
    connection === undefined
      ? ""
      : ` "${connection}" is a connection, not a skill. Find its tools with search({ query: "${connection}__" }).`;
  return `No skill named "${name}".${hint}${connectionHint}`;
}

const SKILL_INPUT_SCHEMA = toInputSchema({
  type: "object",
  properties: { skill: { type: "string" } },
  required: ["skill"],
  additionalProperties: false,
});
