import { createHash } from "node:crypto";
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

/** Nitro `serverAssets` base that holds the root agent's shipped skill files. */
export const SKILL_FILES_SERVER_ASSET_BASE = "eve-skills";

/** Nitro `serverAssets` base that holds {@link SKILL_FILES_INDEX_KEY}. */
export const SKILL_FILES_INDEX_SERVER_ASSET_BASE = "eve-skill-index";

/** Key of the skill file index inside {@link SKILL_FILES_INDEX_SERVER_ASSET_BASE}. */
export const SKILL_FILES_INDEX_KEY = "skills.json";

/**
 * One indexed file: `[path, size, sha256]`. `sha256` is `null` for files over
 * {@link MAX_SKILL_FILE_BYTES}, which are listed but not shipped. A shipped
 * file's storage key is {@link skillFileStorageKey} of its digest.
 */
export type SkillFilesIndexEntry = readonly [path: string, size: number, sha256: string | null];

/**
 * Index of the skill files a production build ships, written by `eve build`.
 * eve owns the listing rather than deriving it from storage keys, so real
 * paths never pass through unstorage key normalization. Entries are arrays,
 * not object keys, so names such as `__proto__` stay plain data.
 */
export interface SkillFilesIndex {
  readonly version: 1;
  /** `[skill, files, directories]`, sorted by skill then path. */
  readonly skills: readonly (readonly [
    skill: string,
    files: readonly SkillFilesIndexEntry[],
    directories: readonly string[],
  ])[];
}

/**
 * Storage key of a shipped skill file: its SHA-256 with a `.bin` name. `.bin`
 * makes Nitro inline the file as a `Uint8Array` whatever its real extension,
 * and a hex name is left unchanged by unstorage key normalization.
 */
export function skillFileStorageKey(sha256: string): string {
  return `${sha256}.bin`;
}

/** The subset of an unstorage `Storage` the server asset source reads with. */
export interface SkillFileStorage {
  getItemRaw(key: string): Promise<unknown>;
}

/** Opens a Nitro server asset storage, e.g. `useStorage("assets:eve-skills")`. */
export type OpenSkillFileStorage = (base: string) => Promise<SkillFileStorage>;

const openNitroStorage: OpenSkillFileStorage = async (base) => {
  const { useStorage } = await import("nitro/storage");
  return useStorage(`assets:${base}`);
};

/**
 * Selects the skill file source for the active compiled artifacts.
 *
 * Skill files are materialized under the node's workspace resource root by
 * `compiler/workspace-resources.ts`. Disk artifacts (dev) read that tree with
 * {@link createDiskSkillFileSource}; bundled artifacts (production builds)
 * read the Nitro server assets `eve build` registers for the root agent.
 */
export function createCompiledSkillFileSource(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly openStorage?: OpenSkillFileStorage;
}): SkillFileSource {
  if (input.compiledArtifactsSource.kind !== "disk") {
    return createServerAssetSkillFileSource(input.openStorage ?? openNitroStorage);
  }
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(
    input.compiledArtifactsSource.appRoot,
  );
  return createDiskSkillFileSource(
    `${compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}/skills`,
  );
}

/**
 * Reads skill files from the Nitro server assets of a production build.
 * Listing and sizes come from the eve index, so an over-limit file is
 * rejected without loading it. The bytes storage returns must match the
 * indexed size and SHA-256; anything else is `unavailable` rather than
 * served altered.
 */
function createServerAssetSkillFileSource(openStorage: OpenSkillFileStorage): SkillFileSource {
  let index: Promise<Map<string, IndexedSkill>> | undefined;
  const loadIndex = () => {
    index ??= openStorage(SKILL_FILES_INDEX_SERVER_ASSET_BASE)
      .then((storage) => storage.getItemRaw(SKILL_FILES_INDEX_KEY))
      .then(parseSkillFilesIndex);
    // A failed load is retried on the next call rather than cached.
    index.catch(() => {
      index = undefined;
    });
    return index;
  };
  return {
    async listFiles(skill) {
      return ((await loadIndex()).get(skill)?.files ?? []).map(([path, size]) => ({ path, size }));
    },
    async listDirectories(skill) {
      return (await loadIndex()).get(skill)?.directories ?? [];
    },
    async readFile(skill, path) {
      const entry = (await loadIndex()).get(skill)?.files.find(([indexed]) => indexed === path);
      if (entry === undefined) throw unknownFile(skill, path);
      const [, size, sha256] = entry;
      if (sha256 === null) throw tooLarge(skill, path, size);
      const storage = await openStorage(SKILL_FILES_SERVER_ASSET_BASE);
      const bytes = await storage.getItemRaw(skillFileStorageKey(sha256));
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== size ||
        createHash("sha256").update(bytes).digest("hex") !== sha256
      ) {
        throw new SkillReadError(
          "unavailable",
          `Skill "${skill}" file "${path}" does not match its build index; this build did not ship it byte for byte.`,
        );
      }
      return bytes;
    },
  };
}

interface IndexedSkill {
  readonly files: readonly SkillFilesIndexEntry[];
  readonly directories: readonly string[];
}

function parseSkillFilesIndex(raw: unknown): Map<string, IndexedSkill> {
  const text =
    typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "";
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isSkillFilesIndex(parsed)) {
    throw new SkillReadError(
      "unavailable",
      "Skill files are not available: this server was not built by `eve build`, so it carries no skill files.",
    );
  }
  return new Map(
    parsed.skills.map(([skill, files, directories]) => [skill, { directories, files }]),
  );
}

function isSkillFilesIndex(value: unknown): value is SkillFilesIndex {
  if (typeof value !== "object" || value === null) return false;
  const { skills, version } = value as { skills?: unknown; version?: unknown };
  return (
    version === 1 &&
    Array.isArray(skills) &&
    skills.every(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        Array.isArray(entry[1]) &&
        entry[1].every(
          (file: unknown) =>
            Array.isArray(file) &&
            file.length === 3 &&
            typeof file[0] === "string" &&
            Number.isSafeInteger(file[1]) &&
            (typeof file[2] === "string" || file[2] === null),
        ) &&
        Array.isArray(entry[2]) &&
        entry[2].every((directory: unknown) => typeof directory === "string"),
    )
  );
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
