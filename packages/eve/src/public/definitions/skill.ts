import type {
  NamedSkillDefinition,
  SkillFileContent,
  SkillPackageDefinition,
} from "#shared/skill-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import { SKILL_BRAND } from "#shared/dynamic-tool-definition.js";

export type { NamedSkillDefinition, SkillFileContent, SkillPackageDefinition };

/**
 * Public definition for skill instructions lowered from authored markdown
 * or authored directly in TypeScript via {@link defineSkill}.
 *
 * Identity is derived from the file path under `agent/skills/`; authored
 * definitions do not carry a `name` field.
 */
export type SkillDefinition = SkillPackageDefinition;

/**
 * Defines a skill in TypeScript using the same shape discovery produces from
 * markdown, with optional package-relative sibling files.
 *
 * When used as the default export of a file in `agent/skills/`, this
 * produces a static skill. When used inside a `defineDynamic` handler,
 * the brand stamp lets the lifecycle code detect single-entry vs
 * map-of-entries return shapes.
 */
export function defineSkill<TSkill extends SkillDefinition>(
  definition: ExactDefinition<TSkill, SkillDefinition>,
): TSkill {
  Object.defineProperty(definition, SKILL_BRAND, { value: true });
  return definition;
}
