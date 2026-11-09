import type { CatalogSkill } from "#execution/catalog/skills.js";
import type { Announcement } from "#harness/announcements.js";
import { SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
  /** False when the skill has no sandbox files; its path is omitted. */
  readonly hasFiles?: boolean;
}

const ANNOUNCEMENT_KEY = "skills";
const NO_SKILLS = "Available skills: none";

/**
 * Formats the "Available skills" section: every skill that isn't deferred,
 * with the instruction to load it. Deferred skills stay out of context until
 * search finds them.
 *
 * A loaded skill's instructions are never injected into the system prompt;
 * the model has them from the result of loading it. The formatter uses the
 * canonical symbolic skill root so supporting files remain discoverable
 * without provisioning a sandbox.
 *
 * eve's default prompt renders it for the agent's static skills on every model
 * call (`definitions/skills.ts`). Dynamic skills reuse it for their announcement.
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
    `If the user names a skill or the request clearly matches one of the descriptions below, load it with ${SKILL_TOOL_NAME}({ name }) before proceeding.`,
    "If multiple skills match, activate the minimal set that covers the task. After activation, follow the returned instructions instead of improvising around them.",
    "If activation fails, say so briefly and continue with the best available alternative.",
    `Skill files live under \`${MODEL_SKILL_ROOT}/<skill>/\`, with \`skills/<skill>/\` under the workspace root as the fallback when \`$HOME\` is unavailable.`,
    "When a loaded SKILL.md mentions sibling files such as `references/foo.md`, resolve them relative to the directory containing that specific SKILL.md.",
    ...skills.map(formatAvailableSkillLine),
  ];

  return lines.join("\n");
}

/**
 * Announces the dynamic skills that aren't deferred, in full whenever they
 * change. Nothing is announced until the first one resolves.
 */
export function dynamicSkillAnnouncements(
  dynamic: readonly CatalogSkill[],
): Readonly<Record<string, Announcement>> {
  const text =
    formatAvailableSkillsSection(
      dynamic
        .filter((skill) => !skill.deferred)
        .map(({ description, name, path }) => ({
          description,
          hasFiles: path !== undefined,
          name,
        })),
    ) ?? NO_SKILLS;
  return { [ANNOUNCEMENT_KEY]: { initial: NO_SKILLS, value: text, render: () => text } };
}

function formatAvailableSkillLine(skill: AvailableSkillDescription): string {
  const prefix = `- ${skill.name}: ${skill.description}`;
  if (skill.hasFiles === false) return prefix;
  return `${prefix} (path: ${skillFilePath(skill.name)})`;
}

/** Where a skill's `SKILL.md` lives under the model's skill root. */
export function skillFilePath(name: string): string {
  return `${MODEL_SKILL_ROOT}/${name}/SKILL.md`;
}
