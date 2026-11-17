import type { CatalogSkill } from "#execution/catalog/skills.js";
import type { Announcement } from "#harness/announcements.js";
import { SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
  readonly hasFiles?: boolean;
}

const ANNOUNCEMENT_KEY = "skills";
const NO_DYNAMIC_SKILLS = "[]";
const ANNOUNCEMENT_SOURCE = "This dynamic skill announcement is from eve, not the user.";
const SKILL_FILE_RULES = [
  `Skill files live under \`${MODEL_SKILL_ROOT}/<skill>/\`, with \`skills/<skill>/\` under the workspace root as the fallback when \`$HOME\` is unavailable.`,
  "When a loaded SKILL.md mentions sibling files such as `references/foo.md`, resolve them relative to the directory containing that specific SKILL.md.",
];

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
    ...(skills.some(({ hasFiles }) => hasFiles !== false) ? SKILL_FILE_RULES : []),
    ...skills.map(formatAvailableSkillLine),
  ];

  return lines.join("\n");
}

export function dynamicSkillAnnouncements(
  dynamic: readonly CatalogSkill[],
  { listedInSystem }: { readonly listedInSystem: boolean },
): Readonly<Record<string, Announcement>> {
  const listed = dynamic
    .filter((skill) => !skill.deferred)
    .map(({ description, name, path }) => ({ description, hasFiles: path !== undefined, name }));
  return {
    [ANNOUNCEMENT_KEY]: {
      initial: NO_DYNAMIC_SKILLS,
      value: JSON.stringify(listed),
      render: (previous) => renderDynamicSkills(listed, announcedNames(previous), listedInSystem),
    },
  };
}

function renderDynamicSkills(
  listed: readonly AvailableSkillDescription[],
  before: readonly string[],
  listedInSystem: boolean,
): string {
  const names = new Set(listed.map(({ name }) => name));
  const gone = before.filter((name) => !names.has(name));
  const body =
    listed.length === 0
      ? "No dynamic skills are available now."
      : listedInSystem
        ? ["Available skills", ...listed.map(formatAvailableSkillLine)].join("\n")
        : formatAvailableSkillsSection(listed);
  return [
    "<skills_update>",
    ANNOUNCEMENT_SOURCE,
    body,
    ...(gone.length > 0 ? [`No longer available: ${gone.join(", ")}`] : []),
    "</skills_update>",
  ].join("\n");
}

function announcedNames(previous: string | undefined): readonly string[] {
  if (previous === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(previous);
    return Array.isArray(parsed)
      ? parsed.flatMap((entry) => (typeof entry?.name === "string" ? [entry.name as string] : []))
      : [];
  } catch {
    return [];
  }
}

function formatAvailableSkillLine(skill: AvailableSkillDescription): string {
  const prefix = `- ${skill.name}: ${skill.description}`;
  if (skill.hasFiles === false) return prefix;
  return `${prefix} (path: ${skillFilePath(skill.name)})`;
}

export function skillFilePath(name: string): string {
  return `${MODEL_SKILL_ROOT}/${name}/SKILL.md`;
}
