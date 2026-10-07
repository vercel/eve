import type { DynamicSkillManifest } from "#context/keys.js";
import type { Announcement } from "#harness/announcements.js";
import { FALLBACK_SKILL_ROOT, MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
  /** False when the skill has no sandbox files; its path is omitted. */
  readonly hasFiles?: boolean;
}

const ANNOUNCEMENT_KEY = "skills";

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
 * Authored skills call this at graph resolution time so the section is part of
 * the turn agent's static instructions. Dynamic skills reuse it for their
 * announcement.
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
    "If the user names a skill or the request clearly matches one of the descriptions below, load it with execute({ skill }) before proceeding.",
    "If multiple skills match, activate the minimal set that covers the task. After activation, follow the returned instructions instead of improvising around them.",
    "If activation fails, say so briefly and continue with the best available alternative.",
    `Skill files live under \`${MODEL_SKILL_ROOT}/<skill>/\`, with \`${FALLBACK_SKILL_ROOT}/<skill>/\` as the fallback when \`$HOME\` is unavailable.`,
    "When a loaded SKILL.md mentions sibling files such as `references/foo.md`, resolve them relative to the directory containing that specific SKILL.md.",
    ...skills.map(formatAvailableSkillLine),
  ];

  return lines.join("\n");
}

/**
 * Announces the dynamic skills that aren't deferred, in full whenever they
 * change. Nothing is announced until the first one resolves. `announced` holds
 * the values announced so far.
 */
export function dynamicSkillAnnouncements(
  manifest: DynamicSkillManifest | undefined,
  announced: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, Announcement>> {
  const skills = Object.values(manifest ?? {})
    .flat()
    .filter((skill) => skill.deferred !== true);
  if (skills.length === 0 && announced?.[ANNOUNCEMENT_KEY] === undefined) return {};
  const text =
    formatAvailableSkillsSection(
      skills.map(({ description, name, revision }) => ({
        description,
        hasFiles: revision !== undefined,
        name,
      })),
    ) ?? "Available skills: none";
  return { [ANNOUNCEMENT_KEY]: { value: text, render: () => text } };
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
