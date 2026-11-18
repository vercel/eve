import type { CatalogSkill } from "#execution/catalog/skills.js";
import { type Announcement, announcementDigest } from "#harness/announcements.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { skillTarget } from "#shared/action-request-name.js";
import { MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
  readonly hasFiles?: boolean;
}

const ANNOUNCEMENT_KEY = "skills";
const NO_SKILLS = "Available skills: none";

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

export function changedSkillAnnouncements(
  skills: ReadonlyMap<string, CatalogSkill>,
  record: readonly HarnessModelMessage[],
): Readonly<Record<string, Announcement>> {
  return Object.fromEntries(
    [...loadedSkills(record)].flatMap(([name, loaded]) => {
      const skill = skills.get(name);
      if (skill === undefined) return [];
      const text = `Skill \`${name}\` changed since you loaded it. Load it again with ${SKILL_TOOL_NAME}({ name: "${name}" }) before relying on it.`;
      const changed = loaded !== skill.markdown;
      return [
        [
          `skills.loaded:${name}`,
          {
            initial: "",
            kind: "context.instruction",
            render: () => (changed ? text : undefined),
            value: changed ? announcementDigest("skill", skill.markdown) : "",
          },
        ],
      ];
    }),
  );
}

function loadedSkills(record: readonly HarnessModelMessage[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const loaded = new Map<string, string>();
  for (const message of record) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolName === SKILL_TOOL_NAME) {
        const name = skillTarget(part.input);
        if (name !== undefined) names.set(part.toolCallId, name);
      }
      if (part.type === "tool-result" && part.toolName === SKILL_TOOL_NAME) {
        const name = names.get(part.toolCallId);
        if (name !== undefined && part.output.type === "text") loaded.set(name, part.output.value);
      }
    }
  }
  return loaded;
}

function formatAvailableSkillLine(skill: AvailableSkillDescription): string {
  const prefix = `- ${skill.name}: ${skill.description}`;
  if (skill.hasFiles === false) return prefix;
  return `${prefix} (path: ${skillFilePath(skill.name)})`;
}

export function skillFilePath(name: string): string {
  return `${MODEL_SKILL_ROOT}/${name}/SKILL.md`;
}
