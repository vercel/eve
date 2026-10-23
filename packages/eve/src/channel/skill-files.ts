import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import nodePath from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";

/** Largest skill file `readSkill` returns. */
export const MAX_SKILL_FILE_BYTES = 512 * 1024;

/** Canonical file name of a skill package's entry markdown. */
export const SKILL_ENTRY_FILE_NAME = "SKILL.md";

/**
 * Whether a file name is a skill's entry markdown. Discovery accepts any case
 * variant, such as `skill.md`, and materialization keeps the authored name.
 */
export function isSkillEntryFileName(name: string): boolean {
  return name.toLowerCase() === "skill.md";
}

export type SkillReadErrorCode =
  | "invalid-path"
  | "too-large"
  | "unavailable"
  | "unknown-file"
  | "unknown-skill";

/** Thrown by `readSkill`. `code` lets a channel map the failure onto its own protocol. */
export class SkillReadError extends Error {
  readonly code: SkillReadErrorCode;

  constructor(code: SkillReadErrorCode, message: string) {
    super(message);
    this.name = "SkillReadError";
    this.code = code;
  }
}

/** One regular file of a skill: its `/`-separated path under the skill root and its size. */
export interface SkillFileEntry {
  readonly path: string;
  readonly size: number;
}

/**
 * Lookup into the compiled skill files of one agent. Paths are `/`-separated
 * and relative to the skill root, e.g. `SKILL.md` or `references/api.md`.
 */
export interface SkillFileSource {
  /** Regular files of one skill, sorted by path. Empty when the skill has no materialized files. */
  listFiles(skill: string): Promise<readonly SkillFileEntry[]>;
  /**
   * Every directory of one skill below its root, sorted by path, including
   * empty ones that no listed file implies.
   */
  listDirectories(skill: string): Promise<readonly string[]>;
  readFile(skill: string, path: string): Promise<Uint8Array>;
}

/**
 * One shipped file: `[path, size, sha256]`. `sha256` is `null` for files over
 * {@link MAX_SKILL_FILE_BYTES}, which are listed but not shipped.
 */
export type BundledSkillFileEntry = readonly [path: string, size: number, sha256: string | null];

/**
 * The root agent's skill files as a production build embeds them, installed
 * by the Nitro plugin `eve build` generates. eve owns the listing, so
 * directories, including empty ones, survive the build. Entries are arrays,
 * not object keys, so names such as `__proto__` stay plain data.
 */
export interface BundledSkillFiles {
  /** `[skill, files, directories]`, sorted by skill then path. */
  readonly skills: readonly (readonly [
    skill: string,
    files: readonly BundledSkillFileEntry[],
    directories: readonly string[],
  ])[];
  /** Reads a shipped file by its SHA-256. */
  read(sha256: string): Promise<Uint8Array>;
}

// Rooted on `globalThis` so every bundled copy of eve sees the build's install.
const BUNDLED_SKILL_FILES_GLOBAL_KEY = Symbol.for("eve.bundled-skill-files");
type BundledSkillFilesGlobal = typeof globalThis & {
  [BUNDLED_SKILL_FILES_GLOBAL_KEY]?: BundledSkillFiles;
};

/** Installs the skill files a production build embeds. */
export function installBundledSkillFiles(files: BundledSkillFiles): void {
  (globalThis as BundledSkillFilesGlobal)[BUNDLED_SKILL_FILES_GLOBAL_KEY] = files;
}

/**
 * Selects the skill file source for the active compiled artifacts.
 *
 * Skill files are materialized under the node's workspace resource root by
 * `compiler/workspace-resources.ts`. Disk artifacts (dev) read that tree with
 * {@link createDiskSkillFileSource}; bundled artifacts (production builds)
 * read the files `eve build` embeds for the root agent.
 */
export function createCompiledSkillFileSource(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly bundledSkillFiles?: BundledSkillFiles;
}): SkillFileSource {
  if (input.compiledArtifactsSource.kind !== "disk") {
    return createBundledSkillFileSource(
      () =>
        input.bundledSkillFiles ??
        (globalThis as BundledSkillFilesGlobal)[BUNDLED_SKILL_FILES_GLOBAL_KEY],
    );
  }
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(
    input.compiledArtifactsSource.appRoot,
  );
  return createDiskSkillFileSource(
    `${compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}/skills`,
  );
}

/**
 * Reads the skill files a production build embeds. Listing and sizes come
 * from the build's index, so an over-limit file is rejected without loading it.
 */
function createBundledSkillFileSource(
  getBundled: () => BundledSkillFiles | undefined,
): SkillFileSource {
  let loaded: { bundled: BundledSkillFiles; index: Map<string, IndexedSkill> } | undefined;
  const load = () => {
    const bundled = getBundled();
    if (bundled === undefined) {
      throw new SkillReadError(
        "unavailable",
        "Skill files are not available: this server was not built by `eve build`, so it carries no skill files.",
      );
    }
    if (loaded?.bundled !== bundled) {
      const index = new Map(
        bundled.skills.map(([skill, files, directories]) => [skill, { directories, files }]),
      );
      loaded = { bundled, index };
    }
    return loaded;
  };
  return {
    async listFiles(skill) {
      return (load().index.get(skill)?.files ?? []).map(([path, size]) => ({ path, size }));
    },
    async listDirectories(skill) {
      return load().index.get(skill)?.directories ?? [];
    },
    async readFile(skill, path) {
      const { bundled, index } = load();
      const entry = index.get(skill)?.files.find(([indexed]) => indexed === path);
      if (entry === undefined) throw unknownFile(skill, path);
      const [, size, sha256] = entry;
      if (sha256 === null) throw tooLarge(skill, path, size);
      // Each embedded file is one module-level array shared by every read and by
      // identical files, so callers get a copy they are free to mutate.
      return (await bundled.read(sha256)).slice();
    },
  };
}

interface IndexedSkill {
  readonly files: readonly BundledSkillFileEntry[];
  readonly directories: readonly string[];
}

/**
 * Reads skill files from a materialized `skills/<name>/` tree.
 *
 * Only regular files reached through real directories are served: a
 * symlinked skill root lists nothing, listing skips symlinks, every path
 * component is checked with `lstat` before opening, the leaf is opened with
 * `O_NOFOLLOW` where the platform defines it, and the `realpath` of the
 * target must stay under the `realpath` of the skill root. These checks are
 * not atomic; the tree is the app's own compile output, so a writer that
 * could race them can already change what is served.
 */
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

/** The regular files and real directories below a skill root, unsorted. */
async function walkSkill(
  skillRoot: string,
): Promise<{ files: SkillFileEntry[]; directories: string[] }> {
  const files: SkillFileEntry[] = [];
  const directories: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // Dirent reports symlinks as neither files nor directories, so they are skipped.
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

/**
 * Reads one file of one skill, byte for byte, given any caller-supplied path.
 *
 * With no `path`, reads the skill's entry markdown under whatever case variant
 * of `SKILL.md` it was authored with. An explicit top-level `SKILL.md` matches
 * the entry file case-insensitively too; every other path must match a listed
 * file exactly. Files over {@link MAX_SKILL_FILE_BYTES} are `too-large`.
 */
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
  // The file can change between the listing and the read.
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
