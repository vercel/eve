/**
 * Skill authoring helpers and runtime accessors.
 */

export type { SkillFile, SkillHandle } from "#execution/skills/types.js";
export {
  defineSkill,
  type NamedSkillDefinition,
  type SkillDefinition,
  type SkillFileContent,
  type SkillPackageDefinition,
} from "#public/definitions/skill.js";
export { defineDynamic } from "#public/definitions/tool.js";
export type { DynamicResolveContext, DynamicSentinel } from "#shared/dynamic-tool-definition.js";
