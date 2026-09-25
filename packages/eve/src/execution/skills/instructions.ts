import { FALLBACK_SKILL_ROOT, MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
  /** False when the skill has no sandbox files; its path is omitted. */
  readonly hasFiles?: boolean;
}

/**
 * Formats the "Available skills" system prompt section.
 *
 * All skills are always listed regardless of activation state. Active skill
 * instructions are never injected into the system prompt — the model already
 * has them from the `load_skill` tool result. The formatter uses the canonical
 * symbolic skill root so supporting files remain discoverable without
 * provisioning a sandbox.
 *
 * Authored skills call this at graph resolution time so the section is
 * part of the turn agent's static instructions. Dynamic skills
 * (`defineDynamic` in `agent/skills/`) reuse the same formatter for
 * durable context announcements.
 */
export function formatAvailableSkillsSection(
  skills: readonly AvailableSkillDescription[],
): string | null {
  if (skills.length === 0) {
    return null;
  }

  const lines = [
    "Available skills",
    "Listed skills are available in this run. Do not claim a listed skill is inaccessible unless activation or workspace inspection actually fails.",
    "Dynamic skill announcements replace earlier dynamic skills and override static skills with the same name. Static skills omitted from a dynamic announcement remain available.",
    "If the user names a skill or the request clearly matches one of the descriptions below, call load_skill before proceeding.",
    "If multiple skills match, activate the minimal set that covers the task. After activation, follow the returned instructions instead of improvising around them.",
    "If activation fails, say so briefly and continue with the best available alternative.",
    `Skill files live under \`${MODEL_SKILL_ROOT}/<skill>/\`, with \`${FALLBACK_SKILL_ROOT}/<skill>/\` as the fallback when \`$HOME\` is unavailable.`,
    "When a loaded SKILL.md mentions sibling files such as `references/foo.md`, resolve them relative to the directory containing that specific SKILL.md.",
    ...skills.map(formatAvailableSkillLine),
  ];

  return lines.join("\n");
}

function formatAvailableSkillLine(skill: AvailableSkillDescription): string {
  const prefix = `- ${skill.name}: ${skill.description}`;
  if (skill.hasFiles === false) return prefix;
  return `${prefix} (path: ${MODEL_SKILL_ROOT}/${skill.name}/SKILL.md)`;
}
