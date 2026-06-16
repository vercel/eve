import type { Dirent } from "node:fs";
import { sep } from "node:path";

/**
 * Supported authored JavaScript and TypeScript module file extensions.
 */
export const SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS = [
  ".cts",
  ".mts",
  ".cjs",
  ".mjs",
  ".ts",
  ".js",
] as const;

/**
 * Files that mark a surrounding directory as an application root when paired
 * with a top-level `agent/` directory.
 */
export const PROJECT_MARKER_FILE_NAMES = ["package.json", "vercel.json"] as const;

const PROJECT_MARKER_FILE_NAME_SET = new Set<string>(PROJECT_MARKER_FILE_NAMES);

/**
 * Filesystem entry type used by discovery classifiers.
 */
export type DirectoryEntryType = "directory" | "file" | "other";

/**
 * Classified root-level agent entry.
 */
export type AgentRootEntryKind =
  | "agent-config-module"
  | "channels-directory"
  | "connections-directory"
  | "hooks-directory"
  | "instructions-directory"
  | "instructions-markdown"
  | "instructions-module"
  | "lib-directory"
  | "sandbox-directory"
  | "schedules-directory"
  | "skills-directory"
  | "system-markdown"
  | "system-module"
  | "tools-directory"
  | "unknown"
  | "subagents-directory";

/**
 * Classified local-subagent root entry.
 */
export type LocalSubagentEntryKind =
  | "agent-config-module"
  | "connections-directory"
  | "hooks-directory"
  | "instructions-directory"
  | "instructions-markdown"
  | "instructions-module"
  | "invalid-schedules-directory"
  | "lib-directory"
  | "sandbox-directory"
  | "skills-directory"
  | "system-markdown"
  | "system-module"
  | "tools-directory"
  | "unknown"
  | "subagents-directory";

/**
 * Classified Agent Skills package entry.
 */
export type SkillPackageEntryKind =
  | "skill-assets-directory"
  | "skill-markdown"
  | "skill-references-directory"
  | "skill-resource"
  | "skill-scripts-directory";

/**
 * Classified top-level entry inside `skills/`.
 */
export type SkillsDirectoryEntryKind =
  | "flat-skill-markdown"
  | "flat-skill-module"
  | "skill-package-directory"
  | "unknown";

/**
 * Returns the normalized entry type for a Node filesystem dirent.
 */
export function getDirectoryEntryType(
  entry: Pick<Dirent, "isDirectory" | "isFile">,
): DirectoryEntryType {
  if (entry.isDirectory()) {
    return "directory";
  }

  if (entry.isFile()) {
    return "file";
  }

  return "other";
}

/**
 * Returns whether an entry marks a directory as an app root for nested agents.
 */
export function isProjectMarkerEntry(name: string, entryType: DirectoryEntryType): boolean {
  return entryType === "file" && PROJECT_MARKER_FILE_NAME_SET.has(name);
}

/**
 * Classifies a top-level agent-root entry according to the spec-legal grammar.
 */
export function classifyAgentRootEntry(
  name: string,
  entryType: DirectoryEntryType,
): AgentRootEntryKind {
  if (entryType === "file") {
    if (matchesSupportedModuleBaseName(name, "agent")) {
      return "agent-config-module";
    }

    if (name.toLowerCase() === "instructions.md") {
      return "instructions-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "instructions")) {
      return "instructions-module";
    }

    if (name.toLowerCase() === "system.md") {
      return "system-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "system")) {
      return "system-module";
    }

    return "unknown";
  }

  if (entryType === "directory") {
    if (name === "channels") {
      return "channels-directory";
    }

    if (name === "connections") {
      return "connections-directory";
    }

    if (name === "hooks") {
      return "hooks-directory";
    }

    if (name === "instructions") {
      return "instructions-directory";
    }

    if (name === "lib") {
      return "lib-directory";
    }

    if (name === "skills") {
      return "skills-directory";
    }

    if (name === "sandbox") {
      return "sandbox-directory";
    }

    if (name === "tools") {
      return "tools-directory";
    }

    if (name === "schedules") {
      return "schedules-directory";
    }

    if (name === "subagents") {
      return "subagents-directory";
    }
  }

  return "unknown";
}

/**
 * Classifies a local-subagent package root entry according to the spec-legal grammar.
 */
export function classifyLocalSubagentEntry(
  name: string,
  entryType: DirectoryEntryType,
): LocalSubagentEntryKind {
  if (entryType === "file") {
    if (matchesSupportedModuleBaseName(name, "agent")) {
      return "agent-config-module";
    }

    if (name.toLowerCase() === "instructions.md") {
      return "instructions-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "instructions")) {
      return "instructions-module";
    }

    if (name.toLowerCase() === "system.md") {
      return "system-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "system")) {
      return "system-module";
    }

    return "unknown";
  }

  if (entryType === "directory") {
    if (name === "connections") {
      return "connections-directory";
    }

    if (name === "hooks") {
      return "hooks-directory";
    }

    if (name === "instructions") {
      return "instructions-directory";
    }

    if (name === "lib") {
      return "lib-directory";
    }

    if (name === "sandbox") {
      return "sandbox-directory";
    }

    if (name === "skills") {
      return "skills-directory";
    }

    if (name === "tools") {
      return "tools-directory";
    }

    if (name === "subagents") {
      return "subagents-directory";
    }

    if (name === "schedules") {
      return "invalid-schedules-directory";
    }
  }

  return "unknown";
}

/**
 * Classifies a file or directory inside an Agent Skills package.
 */
export function classifySkillPackageEntry(
  name: string,
  entryType: DirectoryEntryType,
): SkillPackageEntryKind {
  if (entryType === "file") {
    if (name.toLowerCase() === "skill.md") {
      return "skill-markdown";
    }

    return "skill-resource";
  }

  if (entryType === "directory") {
    if (name === "scripts") {
      return "skill-scripts-directory";
    }

    if (name === "references") {
      return "skill-references-directory";
    }

    if (name === "assets") {
      return "skill-assets-directory";
    }
  }

  return "skill-resource";
}

/**
 * Classifies one top-level entry inside the authored `skills/` directory.
 */
export function classifySkillsDirectoryEntry(
  name: string,
  entryType: DirectoryEntryType,
): SkillsDirectoryEntryKind {
  if (entryType === "directory") {
    return "skill-package-directory";
  }

  if (entryType === "file") {
    if (name.toLowerCase().endsWith(".md")) {
      return "flat-skill-markdown";
    }

    if (getSupportedModuleBaseName(name) !== null) {
      return "flat-skill-module";
    }
  }

  return "unknown";
}

/**
 * Normalizes an agent-root-relative logical path to forward slashes.
 */
export function normalizeLogicalPath(input: string): string {
  return input.replaceAll(sep, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Returns the authored module basename when the file uses a supported module
 * extension.
 */
export function getSupportedModuleBaseName(name: string): string | null {
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (name.endsWith(extension) && name.length > extension.length) {
      return name.slice(0, -extension.length);
    }
  }

  return null;
}

/**
 * Returns whether the file name matches one supported authored module basename.
 */
export function matchesSupportedModuleBaseName(name: string, baseName: string): boolean {
  return getSupportedModuleBaseName(name) === baseName;
}

/**
 * Removes a final file extension from a logical path when present.
 */
export function stripLogicalPathExtension(input: string): string {
  const normalizedPath = normalizeLogicalPath(input);
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  const lastDotIndex = normalizedPath.lastIndexOf(".");

  if (lastDotIndex === -1 || lastDotIndex < lastSlashIndex) {
    return normalizedPath;
  }

  return normalizedPath.slice(0, lastDotIndex);
}
