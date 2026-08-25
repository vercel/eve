/**
 * Skill authoring helpers and runtime accessors.
 */

export type { SkillFile, SkillHandle } from "#shared/skill-types.js";
export {
  defineSkill,
  type NamedSkillDefinition,
  type SkillDefinition,
  type SkillFileContent,
  type SkillPackageDefinition,
} from "#public/definitions/skill.js";
export { defineDynamic } from "#dynamic/definition.js";
export type { DynamicResolveContext, DynamicSentinel } from "#dynamic/definition.js";
