import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import nodePath from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";

export const MAX_SKILL_FILE_BYTES = 512 * 1024;

export const SKILL_ENTRY_FILE_NAME = "SKILL.md";

export function isSkillEntryFileName(name: string): boolean {
  return name.toLowerCase() === "skill.md";
}

export type SkillReadErrorCode =
  | "invalid-path"
  | "too-large"
  | "unavailable"
  | "unknown-file"
  | "unknown-skill";

export class SkillReadError extends Error {
  readonly code: SkillReadErrorCode;

  constructor(code: SkillReadErrorCode, message: string) {
    super(message);
    this.name = "SkillReadError";
    this.code = code;
  }
}

export interface SkillFileEntry {
  readonly path: string;
  readonly size: number;
}

export interface SkillFileSource {
  listFiles(skill: string): Promise<readonly SkillFileEntry[]>;
  listDirectories(skill: string): Promise<readonly string[]>;
  readFile(skill: string, path: string): Promise<Uint8Array>;
}

export type SkillFilesIndexEntry = readonly [path: string, size: number, sha256: string | null];

export interface SkillFilesIndex {
  readonly skills: readonly (readonly [
    skill: string,
    files: readonly SkillFilesIndexEntry[],
    directories: readonly string[],
  ])[];
}

export interface BundledSkillFiles {
  readonly index: string;
  readonly read: (sha256: string) => Promise<Uint8Array>;
}

export interface InstalledSkillFiles {
  readonly read: (sha256: string) => Promise<Uint8Array>;
  readonly skills: ReadonlyMap<string, IndexedSkill>;
}

interface IndexedSkill {
  readonly files: readonly SkillFilesIndexEntry[];
  readonly directories: readonly string[];
}

export function installBundledSkillFiles(input: BundledSkillFiles): void {
  const index = JSON.parse(input.index) as SkillFilesIndex;
  getActiveRuntimeSession().skillFiles = {
    read: input.read,
    skills: new Map(
      index.skills.map(([skill, files, directories]) => [skill, { directories, files }]),
    ),
  };
}

export function createCompiledSkillFileSource(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): SkillFileSource {
  if (input.compiledArtifactsSource.kind !== "disk") {
    return bundledSkillFileSource;
  }
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(
    input.compiledArtifactsSource.appRoot,
  );
  return createDiskSkillFileSource(
    `${compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}/skills`,
  );
}

const bundledSkillFileSource: SkillFileSource = {
  async listFiles(skill) {
    return (installedSkillFiles().skills.get(skill)?.files ?? []).map(([path, size]) => ({
      path,
      size,
    }));
  },
  async listDirectories(skill) {
    return installedSkillFiles().skills.get(skill)?.directories ?? [];
  },
  async readFile(skill, path) {
    const installed = installedSkillFiles();
    const entry = installed.skills.get(skill)?.files.find(([indexed]) => indexed === path);
    if (entry === undefined) throw unknownFile(skill, path);
    const [, size, sha256] = entry;
    if (sha256 === null) throw tooLarge(skill, path, size);
    return (await installed.read(sha256)).slice();
  },
};

function installedSkillFiles(): InstalledSkillFiles {
  const installed = getActiveRuntimeSession().skillFiles;
  if (installed === null) {
    throw new SkillReadError(
      "unavailable",
      "Skill files are not available: this server was not built by `eve build`, so it carries no skill files.",
    );
  }
  return installed;
}

export function createDiskSkillFileSource(skillsRoot: string): SkillFileSource {
  return {
    async listFiles(skill) {
      const skillRoot = `${skillsRoot}/${skill}`;
      if (!(await isRealDirectory(skillRoot))) return [];
      const { files } = await walkSkill(skillRoot);
      return files.sort((left, right) => comparePaths(left.path, right.path));
    },
    async listDirectories(skill) {
      const skillRoot = `${skillsRoot}/${skill}`;
      if (!(await isRealDirectory(skillRoot))) return [];
      const { directories } = await walkSkill(skillRoot);
      return directories.sort(comparePaths);
    },
    async readFile(skill, path) {
      const skillRoot = `${skillsRoot}/${skill}`;
      if (!(await isRealDirectory(skillRoot))) throw unknownFile(skill, path);
      const segments = path.split("/");
      let current = skillRoot;
      for (const [index, segment] of segments.entries()) {
        current = `${current}/${segment}`;
        const stats = await lstatOrUndefined(current);
        const isLeaf = index === segments.length - 1;
        if (stats === undefined || (isLeaf ? !stats.isFile() : !stats.isDirectory())) {
          throw unknownFile(skill, path);
        }
      }
      const [realRoot, realTarget] = await Promise.all([realpath(skillRoot), realpath(current)]);
      const relative = nodePath.relative(realRoot, realTarget);
      if (
        relative === "" ||
        nodePath.isAbsolute(relative) ||
        relative.split(nodePath.sep)[0] === ".."
      ) {
        throw unknownFile(skill, path);
      }
      const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw unknownFile(skill, path);
        if (stats.size > MAX_SKILL_FILE_BYTES) throw tooLarge(skill, path, stats.size);
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
  };
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  return (await lstatOrUndefined(path))?.isDirectory() === true;
}

async function walkSkill(
  skillRoot: string,
): Promise<{ files: SkillFileEntry[]; directories: string[] }> {
  const files: SkillFileEntry[] = [];
  const directories: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(path);
        await walk(`${directory}/${entry.name}`, path);
      } else if (entry.isFile()) {
        const stats = await lstatOrUndefined(`${directory}/${entry.name}`);
        if (stats?.isFile() === true) files.push({ path, size: stats.size });
      }
    }
  };
  await walk(skillRoot, "");
  return { directories, files };
}

function unknownFile(skill: string, path: string): SkillReadError {
  return new SkillReadError("unknown-file", `Skill "${skill}" has no file "${path}".`);
}

function tooLarge(skill: string, path: string, size: number): SkillReadError {
  return new SkillReadError(
    "too-large",
    `Skill "${skill}" file "${path}" is ${size} bytes, over the ${MAX_SKILL_FILE_BYTES}-byte limit.`,
  );
}

export async function readSkillFile(input: {
  readonly path?: string;
  readonly skill: string;
  readonly source: SkillFileSource;
}): Promise<Uint8Array> {
  const requested = input.path ?? SKILL_ENTRY_FILE_NAME;
  assertRelativeSkillPath(requested);
  const files = await input.source.listFiles(input.skill);
  const file =
    files.find((entry) => entry.path === requested) ??
    (isSkillEntryFileName(requested)
      ? files.find((entry) => isSkillEntryFileName(entry.path))
      : undefined);
  if (file === undefined) throw unknownFile(input.skill, requested);
  if (file.size > MAX_SKILL_FILE_BYTES) throw tooLarge(input.skill, file.path, file.size);
  const bytes = await input.source.readFile(input.skill, file.path);
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw tooLarge(input.skill, file.path, bytes.byteLength);
  }
  return bytes;
}

function assertRelativeSkillPath(path: string): void {
  const invalid = (reason: string) =>
    new SkillReadError("invalid-path", `Skill file path "${path}" ${reason}.`);
  if (path.length === 0) throw invalid("must not be empty");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw invalid("must be relative to the skill root");
  }
  if (path.includes("\\") || path.includes("\0")) {
    throw invalid('must use "/" separators and contain no NUL bytes');
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalid('must not contain empty, ".", or ".." segments');
  }
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
