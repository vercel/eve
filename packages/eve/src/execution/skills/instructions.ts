import { FALLBACK_SKILL_ROOT, MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

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
 * has them from the `load_skill` tool result. Without an active sandbox root,
 * the formatter uses the canonical symbolic skill root so supporting files
 * remain discoverable without provisioning a sandbox.
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
  if (options.skillRoot !== undefined) {
    return `Skill files live under \`${options.skillRoot}/<skill>/\`.`;
  }

  return `Skill files live under \`${MODEL_SKILL_ROOT}/<skill>/\`, with \`${FALLBACK_SKILL_ROOT}/<skill>/\` as the fallback when \`$HOME\` is unavailable.`;
}

function formatAvailableSkillLine(input: {
  readonly skill: AvailableSkillDescription;
  readonly skillRoot?: string;
}): string {
  const prefix = `- ${input.skill.name}: ${input.skill.description}`;

  const skillRoot = input.skillRoot ?? MODEL_SKILL_ROOT;
  return `${prefix} (path: ${skillRoot}/${input.skill.name}/SKILL.md)`;
}
