import type { CatalogSkill, SkillLoadProvenance } from "#execution/catalog/skills.js";
import type { Announcement } from "#harness/announcements.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { skillTarget } from "#shared/action-request-name.js";
import { isObject } from "#shared/guards.js";
import { MODEL_SKILL_ROOT } from "#shared/skill-paths.js";

export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
  readonly hasFiles?: boolean;
}

const ANNOUNCEMENT_KEY = "skills";
const SKILL_RELOAD_KEY = "eve.skill-reload";
const NO_SKILLS = "Available skills: none";

export interface AvailableSkillSectionOptions {
  readonly skillRoot?: string;
}

export function formatAvailableSkillsSection(
  skills: readonly AvailableSkillDescription[],
  options: AvailableSkillSectionOptions = {},
): string | null {
  if (skills.length === 0) {
    return null;
  }

  const root = options.skillRoot ?? MODEL_SKILL_ROOT;
  const locationLine =
    root === MODEL_SKILL_ROOT
      ? `Files live under \`${MODEL_SKILL_ROOT}/<skill>/\` (fallback \`skills/<skill>/\` when \`$HOME\` is unavailable); resolve sibling references relative to that \`SKILL.md\`. Later dynamic announcements replace earlier dynamic entries and override same-named static skills; omitted static skills stay available.`
      : `Files live under \`${root}/<skill>/\`; resolve sibling references relative to that \`SKILL.md\`. Later dynamic announcements replace earlier dynamic entries and override same-named static skills; omitted static skills stay available.`;

  const lines = [
    "Available skills",
    `Load the minimal matching skills with ${SKILL_TOOL_NAME}({ name }) when named by the user or clearly matching the task, then follow their instructions. Do not claim a listed skill is inaccessible unless loading fails.`,
    locationLine,
    ...skills.map((skill) => formatAvailableSkillLine(skill, root)),
  ];

  return lines.join("\n");
}

export function dynamicSkillAnnouncements(
  dynamic: readonly CatalogSkill[],
  options: AvailableSkillSectionOptions = {},
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
      options,
    ) ?? NO_SKILLS;
  return { [ANNOUNCEMENT_KEY]: { initial: NO_SKILLS, value: text, render: () => text } };
}

export function changedSkillAnnouncements(
  skills: ReadonlyMap<string, CatalogSkill>,
  record: readonly HarnessModelMessage[],
): Readonly<Record<string, Announcement>> {
  return Object.fromEntries(
    [...loadedSkills(record)].flatMap(([name, loaded]) => {
      const current = staticSkillProvenance(skills.get(name));
      if (current === undefined) return [];
      const source = skillSourceKey(current);
      if (source !== skillSourceKey(loaded)) return [];
      const changed = loaded.revision !== current.revision;
      return [
        [
          `skills.loaded:${source}`,
          {
            initial: "",
            kind: "context.instruction",
            metadata: { [SKILL_RELOAD_KEY]: { name, source } },
            render: () =>
              changed
                ? `Skill \`${name}\` changed since you loaded it. Load it again with ${SKILL_TOOL_NAME}({ name: "${name}" }) before relying on it.`
                : undefined,
            value: changed ? current.revision : "",
          },
        ],
      ];
    }),
  );
}

export function visibleSkillNotice(
  message: HarnessModelMessage,
  skills: ReadonlyMap<string, CatalogSkill>,
): boolean {
  if (message.role !== "user" || message.kind !== "context.instruction") return true;
  const notice = message.metadata?.[SKILL_RELOAD_KEY];
  if (notice === undefined) return true;
  if (!isObject(notice) || typeof notice.name !== "string") return false;
  const current = staticSkillProvenance(skills.get(notice.name));
  return current !== undefined && skillSourceKey(current) === notice.source;
}

function staticSkillProvenance(skill: CatalogSkill | undefined): SkillLoadProvenance | undefined {
  return skill?.source === undefined ? skill?.provenance : undefined;
}

function skillSourceKey(source: SkillLoadProvenance): string {
  return JSON.stringify([source.scope, source.identity]);
}

function loadedSkills(
  record: readonly HarnessModelMessage[],
): ReadonlyMap<string, SkillLoadProvenance> {
  const names = new Map<string, string>();
  const loaded = new Map<string, SkillLoadProvenance>();
  for (const message of record) {
    if (message.role === "assistant" && typeof message.content !== "string") {
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolName !== SKILL_TOOL_NAME) continue;
        const name = skillTarget(part.input);
        if (name !== undefined) names.set(part.toolCallId, name);
      }
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== SKILL_TOOL_NAME) continue;
      if (part.output.type !== "text") continue;
      const name = names.get(part.toolCallId);
      if (name === undefined) continue;
      const load = "skillLoad" in part ? part.skillLoad : undefined;
      if (
        isObject(load) &&
        typeof load.identity === "string" &&
        typeof load.scope === "string" &&
        typeof load.revision === "string"
      ) {
        loaded.set(name, { identity: load.identity, scope: load.scope, revision: load.revision });
      } else {
        loaded.delete(name);
      }
    }
  }
  return loaded;
}

function formatAvailableSkillLine(skill: AvailableSkillDescription, root: string): string {
  const prefix = `- ${skill.name}: ${skill.description}`;
  if (skill.hasFiles === false) return prefix;
  return `${prefix} (path: ${skillFilePath(skill.name, root)})`;
}

export function skillFilePath(name: string, root: string = MODEL_SKILL_ROOT): string {
  return `${root}/${name}/SKILL.md`;
}
