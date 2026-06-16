import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
}

/**
 * Formats the "Available skills" system prompt section.
 *
 * All skills are always listed regardless of activation state. Active skill
 * instructions are never injected into the system prompt — the model already
 * has them from the `load_skill` tool result. This keeps the system
 * prompt identical across the entire session, preserving prompt caching.
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
    "If the user names a skill or the request clearly matches one of the descriptions below, call load_skill before proceeding.",
    "If multiple skills match, activate the minimal set that covers the task. After activation, follow the returned instructions instead of improvising around them.",
    "If activation fails, say so briefly and continue with the best fallback. Packaged sibling files under a skill path can be inspected with bash or read_file when needed.",
    ...skills.map((skill) => formatAvailableSkillLine(skill)),
  ];

  return lines.join("\n");
}

function formatAvailableSkillLine(skill: AvailableSkillDescription): string {
  return `- ${skill.name}: ${skill.description} (path: ${WORKSPACE_ROOT}/skills/${skill.name}/SKILL.md)`;
}
