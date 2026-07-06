export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
}

interface FormatAvailableSkillsSectionOptions {
  readonly skillRoot?: string;
}

/**
 * Formats the "Available skills" system prompt section.
 *
 * All skills are always listed regardless of activation state. Active skill
 * instructions are never injected into the system prompt — the model already
 * has them from the `load_skill` tool result. The caller may pass the active
 * sandbox skill root so the model sees only the location that eve selected
 * for this run.
 *
 * Authored skills call this at graph resolution time so the section is
 * part of the turn agent's static instructions. Dynamic skills
 * (`defineDynamic` in `agent/skills/`) reuse the same formatter for
 * durable context announcements.
 */
export function formatAvailableSkillsSection(
  skills: readonly AvailableSkillDescription[],
  options: FormatAvailableSkillsSectionOptions = {},
): string | null {
  if (skills.length === 0) {
    return null;
  }

  const lines = [
    "Available skills",
    "Listed skills are available in this run. Do not claim a listed skill is inaccessible unless activation or workspace inspection actually fails.",
    "If the user names a skill or the request clearly matches one of the descriptions below, call load_skill before proceeding.",
    "If multiple skills match, activate the minimal set that covers the task. After activation, follow the returned instructions instead of improvising around them.",
    "If activation fails, say so briefly and continue with the best available alternative.",
    formatSkillLocationLine(options),
    "When a loaded SKILL.md mentions sibling files such as `references/foo.md`, resolve them relative to the directory containing that specific SKILL.md.",
    ...skills.map((skill) => formatAvailableSkillLine({ skill, skillRoot: options.skillRoot })),
  ];

  return lines.join("\n");
}

function formatSkillLocationLine(options: FormatAvailableSkillsSectionOptions): string {
  if (options.skillRoot === undefined) {
    return "Skill files are available after load_skill resolves the active sandbox skill location.";
  }

  return `Skill files live under \`${options.skillRoot}/<skill>/\`.`;
}

function formatAvailableSkillLine(input: {
  readonly skill: AvailableSkillDescription;
  readonly skillRoot?: string;
}): string {
  const prefix = `- ${input.skill.name}: ${input.skill.description}`;

  if (input.skillRoot === undefined) {
    return prefix;
  }

  return `${prefix} (path: ${input.skillRoot}/${input.skill.name}/SKILL.md)`;
}
