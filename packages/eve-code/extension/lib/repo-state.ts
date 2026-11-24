import { defineState } from "eve/context";
import type { SkillDefinition, SkillFileContent } from "eve/skills";

import type { RepositoryInstructionFile } from "../extension.ts";

export const MAX_CHECKED_DIRS = 500;
export const REPOSITORY_SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,57}$/u;

export function isValidRepositorySkillName(name: string): boolean {
  return REPOSITORY_SKILL_NAME_PATTERN.test(name) && !/^eve__/iu.test(name);
}

export interface SerializedSkillFile {
  readonly encoding: "utf8" | "base64";
  readonly data: string;
}

export interface SerializedSkillDefinition {
  readonly deferred?: boolean;
  readonly description: string;
  readonly license?: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly files?: Readonly<Record<string, SerializedSkillFile>>;
}

export interface RecordedRepository {
  readonly root: string;
  readonly slug: string | null;
  readonly remote: string | null;
  readonly head: string | null;
  readonly branch: string | null;
  readonly sparse: boolean;
  readonly instructions: readonly RepositoryInstructionFile[];
  readonly ruleFiles: readonly RepositoryInstructionFile[];
  readonly ruleInstructions: readonly string[];
  readonly ruleSkills: Readonly<Record<string, SerializedSkillDefinition>>;
  readonly enteredAtHead: string | null;
}

export interface RecordedScope {
  readonly dir: string;
  readonly repoRoot: string | null;
  readonly repoSlug: string | null;
  readonly files: readonly RepositoryInstructionFile[];
}

export interface PendingRepositoryReconcile {
  readonly extraPaths: readonly string[];
}

export interface RepositorySessionState {
  readonly workspaceRoot: string | null;
  readonly rawWorkspaceRoot: string | null;
  readonly homeDir: string | null;
  readonly workspaceInstruction: readonly RepositoryInstructionFile[];
  readonly byRoot: Readonly<Record<string, RecordedRepository>>;
  readonly scopes: Readonly<Record<string, RecordedScope>>;
  readonly checkedDirs: readonly string[];
  readonly syncedTurnId: string | null;
  readonly pendingReconcile: PendingRepositoryReconcile | null;
  readonly revision: number;
}

export function initialRepositorySessionState(): RepositorySessionState {
  return {
    workspaceRoot: null,
    rawWorkspaceRoot: null,
    homeDir: null,
    workspaceInstruction: [],
    byRoot: {},
    scopes: {},
    checkedDirs: [],
    syncedTurnId: null,
    pendingReconcile: null,
    revision: 0,
  };
}

export const repoState = defineState<RepositorySessionState>(
  "repositories",
  initialRepositorySessionState,
);

export function appendCheckedDirs(
  existing: readonly string[],
  added: readonly string[],
): readonly string[] {
  if (added.length === 0) return existing;
  const set = new Set(existing);
  for (const dir of added) {
    set.delete(dir);
    set.add(dir);
  }
  const list = [...set];
  return list.length > MAX_CHECKED_DIRS ? list.slice(list.length - MAX_CHECKED_DIRS) : list;
}

export function invalidateRepoCheckedDirs(
  existing: readonly string[],
  repoRoot: string,
): readonly string[] {
  const prefix = repoRoot === "/" ? "/" : `${repoRoot}/`;
  return existing.filter((dir) => dir !== repoRoot && !dir.startsWith(prefix));
}

export function serializeSkill(skill: SkillDefinition): SerializedSkillDefinition {
  let files: Record<string, SerializedSkillFile> | undefined;
  if (skill.files !== undefined) {
    files = {};
    for (const [name, value] of Object.entries(skill.files)) {
      if (typeof value === "string") {
        files[name] = { encoding: "utf8", data: value };
      } else {
        files[name] = { encoding: "base64", data: Buffer.from(value).toString("base64") };
      }
    }
  }
  return {
    ...(skill.deferred !== undefined && { deferred: skill.deferred }),
    description: skill.description,
    ...(skill.license !== undefined && { license: skill.license }),
    content: skill.content,
    ...(skill.metadata !== undefined && { metadata: { ...skill.metadata } }),
    ...(files !== undefined && { files }),
  };
}

export function deserializeSkill(serialized: SerializedSkillDefinition): SkillDefinition {
  let files: Record<string, SkillFileContent> | undefined;
  if (serialized.files !== undefined) {
    files = {};
    for (const [name, entry] of Object.entries(serialized.files)) {
      files[name] =
        entry.encoding === "base64"
          ? new Uint8Array(Buffer.from(entry.data, "base64"))
          : entry.data;
    }
  }
  return {
    ...(serialized.deferred !== undefined && { deferred: serialized.deferred }),
    description: serialized.description,
    ...(serialized.license !== undefined && { license: serialized.license }),
    content: serialized.content,
    ...(serialized.metadata !== undefined && { metadata: { ...serialized.metadata } }),
    ...(files !== undefined && { files }),
  };
}
