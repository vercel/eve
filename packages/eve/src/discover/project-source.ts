import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, sep } from "node:path";

export interface ProjectSourceEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export type ProjectSourceEntryKind = "directory" | "file" | "missing" | "other";

export interface ProjectSource {
  readonly kind: "disk" | "memory";
  readDirectory(directoryPath: string): Promise<readonly ProjectSourceEntry[]>;
  readTextFile(filePath: string): Promise<string>;
  stat(targetPath: string): Promise<ProjectSourceEntryKind>;
}

export function createDiskProjectSource(): ProjectSource {
  return {
    kind: "disk",
    async readDirectory(directoryPath) {
      return await readdir(directoryPath, { withFileTypes: true });
    },
    async readTextFile(filePath) {
      return await readFile(filePath, "utf8");
    },
    async stat(targetPath) {
      try {
        const stats = await stat(targetPath);

        if (stats.isDirectory()) {
          return "directory";
        }

        if (stats.isFile()) {
          return "file";
        }

        return "other";
      } catch {
        return "missing";
      }
    },
  };
}

interface MemoryProjectSourceInput {
  readonly rootDir?: string;
  readonly files: Readonly<Record<string, string | { readonly content: string }>>;
  readonly directories?: readonly string[];
}

export function createMemoryProjectSource(input: MemoryProjectSourceInput): ProjectSource {
  const filesByNormalizedPath = new Map<string, string>();
  const directoriesByNormalizedPath = new Map<string, Map<string, "file" | "directory">>();

  function registerDirectory(normalizedDirectoryPath: string): Map<string, "file" | "directory"> {
    let entries = directoriesByNormalizedPath.get(normalizedDirectoryPath);

    if (entries === undefined) {
      entries = new Map();
      directoriesByNormalizedPath.set(normalizedDirectoryPath, entries);
    }

    return entries;
  }

  function registerChildOfDirectory(
    normalizedDirectoryPath: string,
    childName: string,
    childKind: "file" | "directory",
  ): void {
    const existing = registerDirectory(normalizedDirectoryPath).get(childName);
    if (existing === "file" && childKind === "directory") {
      throw new TypeError(
        `MemoryProjectSource: path "${posix.join(normalizedDirectoryPath, childName)}" registered as both a file and a directory.`,
      );
    }
    registerDirectory(normalizedDirectoryPath).set(childName, childKind);
  }

  for (const [rawPath, value] of Object.entries(input.files)) {
    const normalizedPath = normalizeToPosix(rawPath);
    const content = typeof value === "string" ? value : value.content;

    filesByNormalizedPath.set(normalizedPath, content);

    const segments = splitPosixPath(normalizedPath);

    if (segments.length === 0) {
      throw new TypeError(`MemoryProjectSource: cannot register root path "${rawPath}" as a file.`);
    }

    const fileName = segments[segments.length - 1];

    if (fileName === undefined) {
      throw new TypeError(`MemoryProjectSource: empty file name in "${rawPath}".`);
    }

    let currentDirectoryPath = "/";

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];

      if (segment === undefined) {
        continue;
      }

      registerChildOfDirectory(currentDirectoryPath, segment, "directory");
      currentDirectoryPath =
        currentDirectoryPath === "/" ? `/${segment}` : `${currentDirectoryPath}/${segment}`;
    }

    registerChildOfDirectory(currentDirectoryPath, fileName, "file");
  }

  for (const rawDirectoryPath of input.directories ?? []) {
    const normalizedDirectoryPath = normalizeToPosix(rawDirectoryPath);
    const directorySegments = splitPosixPath(normalizedDirectoryPath);

    registerDirectory(normalizedDirectoryPath);

    let ancestorDirectoryPath = "/";

    for (let index = 0; index < directorySegments.length; index += 1) {
      const segment = directorySegments[index];

      if (segment === undefined) {
        continue;
      }

      registerChildOfDirectory(ancestorDirectoryPath, segment, "directory");
      ancestorDirectoryPath =
        ancestorDirectoryPath === "/" ? `/${segment}` : `${ancestorDirectoryPath}/${segment}`;
    }
  }

  return {
    kind: "memory",
    async readDirectory(directoryPath) {
      const normalized = normalizeToPosix(directoryPath);
      const entries = directoriesByNormalizedPath.get(normalized);

      if (entries === undefined) {
        throw new Error(
          `MemoryProjectSource: directory "${directoryPath}" does not exist${
            input.rootDir === undefined ? "" : ` (root: ${input.rootDir})`
          }.`,
        );
      }

      return [...entries.entries()].map(([name, kind]) => createMemoryEntry(name, kind));
    },
    async readTextFile(filePath) {
      const normalized = normalizeToPosix(filePath);
      const content = filesByNormalizedPath.get(normalized);

      if (content === undefined) {
        throw new Error(
          `MemoryProjectSource: file "${filePath}" does not exist${
            input.rootDir === undefined ? "" : ` (root: ${input.rootDir})`
          }.`,
        );
      }

      return content;
    },
    async stat(targetPath) {
      const normalized = normalizeToPosix(targetPath);

      if (filesByNormalizedPath.has(normalized)) {
        return "file";
      }

      if (directoriesByNormalizedPath.has(normalized)) {
        return "directory";
      }

      return "missing";
    },
  };
}

function createMemoryEntry(name: string, kind: "file" | "directory"): ProjectSourceEntry {
  return {
    name,
    isDirectory() {
      return kind === "directory";
    },
    isFile() {
      return kind === "file";
    },
  };
}

export async function readPackageJsonName(
  source: ProjectSource,
  root: string,
): Promise<string | undefined> {
  try {
    const { name } = JSON.parse(await source.readTextFile(join(root, "package.json"))) as {
      name?: unknown;
    };
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function normalizeToPosix(path: string): string {
  const withPosixSeparators = sep === "/" ? path : path.replaceAll(sep, "/");

  if (withPosixSeparators.length === 0) {
    return "/";
  }

  const driveStripped = withPosixSeparators.replace(/^[A-Za-z]:/, "");
  const withLeadingSlash = driveStripped.startsWith("/") ? driveStripped : `/${driveStripped}`;

  return posix.normalize(withLeadingSlash).replace(/\/+$/, "") || "/";
}

function splitPosixPath(normalizedPath: string): string[] {
  return normalizedPath.split("/").filter((segment) => segment.length > 0);
}
