import type { Dirent } from "node:fs";
import { sep } from "node:path";

export const SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS = [
  ".cts",
  ".mts",
  ".cjs",
  ".mjs",
  ".ts",
  ".js",
] as const;

const PROJECT_MARKER_FILE_NAMES = ["package.json", "vercel.json"] as const;

const PROJECT_MARKER_FILE_NAME_SET = new Set<string>(PROJECT_MARKER_FILE_NAMES);
const GENERATED_AGENT_DIRECTORY_NAMES = new Set<string>([
  ".devtools",
  ".eve",
  ".next",
  ".output",
  ".vercel",
  "node_modules",
]);

export type DirectoryEntryType = "directory" | "file" | "other";

type AgentRootEntryKind =
  | "agent-config-module"
  | "channels-directory"
  | "connections-directory"
  | "extensions-directory"
  | "hooks-directory"
  | "ignored-directory"
  | "instrumentation-directory"
  | "instructions-directory"
  | "instructions-markdown"
  | "instructions-module"
  | "lib-directory"
  | "memory-directory"
  | "memory-module"
  | "sandbox-directory"
  | "schedules-directory"
  | "skills-directory"
  | "system-markdown"
  | "system-module"
  | "tools-directory"
  | "unknown"
  | "subagents-directory";

type LocalSubagentEntryKind =
  | "agent-config-module"
  | "connections-directory"
  | "extensions-directory"
  | "hooks-directory"
  | "ignored-directory"
  | "instructions-directory"
  | "instructions-markdown"
  | "instructions-module"
  | "invalid-schedules-directory"
  | "lib-directory"
  | "memory-directory"
  | "memory-module"
  | "sandbox-directory"
  | "skills-directory"
  | "system-markdown"
  | "system-module"
  | "tools-directory"
  | "unknown"
  | "subagents-directory";

type SkillPackageEntryKind =
  | "skill-assets-directory"
  | "skill-markdown"
  | "skill-references-directory"
  | "skill-resource"
  | "skill-scripts-directory";

type SkillsDirectoryEntryKind =
  | "flat-skill-markdown"
  | "flat-skill-module"
  | "ignored-declaration"
  | "ignored-source-map"
  | "skill-package-directory"
  | "unknown";

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

export function isProjectMarkerEntry(name: string, entryType: DirectoryEntryType): boolean {
  return entryType === "file" && PROJECT_MARKER_FILE_NAME_SET.has(name);
}

export function isDiscoverableAgentRootEntry(name: string, entryType: DirectoryEntryType): boolean {
  const kind = classifyAgentRootEntry(name, entryType);
  return (
    kind !== "unknown" &&
    kind !== "ignored-directory" &&
    kind !== "lib-directory" &&
    kind !== "memory-directory"
  );
}

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

    if (matchesSupportedModuleBaseName(name, "memory")) return "memory-module";

    if (name.toLowerCase() === "system.md") {
      return "system-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "system")) {
      return "system-module";
    }

    return "unknown";
  }

  if (entryType === "directory") {
    if (GENERATED_AGENT_DIRECTORY_NAMES.has(name)) {
      return "ignored-directory";
    }

    if (name === "channels") {
      return "channels-directory";
    }

    if (name === "connections") {
      return "connections-directory";
    }

    if (name === "extensions") {
      return "extensions-directory";
    }

    if (name === "hooks") {
      return "hooks-directory";
    }

    if (name === "instructions") {
      return "instructions-directory";
    }

    if (name === "instrumentation") {
      return "instrumentation-directory";
    }

    if (name === "lib") {
      return "lib-directory";
    }

    if (name === "memory") return "memory-directory";

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

    if (matchesSupportedModuleBaseName(name, "memory")) return "memory-module";

    if (name.toLowerCase() === "system.md") {
      return "system-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "system")) {
      return "system-module";
    }

    return "unknown";
  }

  if (entryType === "directory") {
    if (GENERATED_AGENT_DIRECTORY_NAMES.has(name)) {
      return "ignored-directory";
    }

    if (name === "connections") {
      return "connections-directory";
    }

    if (name === "extensions") {
      return "extensions-directory";
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

    if (name === "memory") return "memory-directory";

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

export function classifySkillsDirectoryEntry(
  name: string,
  entryType: DirectoryEntryType,
): SkillsDirectoryEntryKind {
  if (entryType === "directory") {
    return "skill-package-directory";
  }

  if (entryType === "file") {
    if (isTypeScriptDeclarationFileName(name)) {
      return "ignored-declaration";
    }

    if (isGeneratedSourceMapFileName(name)) {
      return "ignored-source-map";
    }

    if (name.toLowerCase().endsWith(".md")) {
      return "flat-skill-markdown";
    }

    if (getSupportedModuleBaseName(name) !== null) {
      return "flat-skill-module";
    }
  }

  return "unknown";
}

export function normalizeLogicalPath(input: string): string {
  return input.replaceAll(sep, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function getSupportedModuleBaseName(name: string): string | null {
  if (isTypeScriptDeclarationFileName(name)) {
    return null;
  }

  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (name.endsWith(extension) && name.length > extension.length) {
      return name.slice(0, -extension.length);
    }
  }

  return null;
}

export function isTypeScriptDeclarationFileName(name: string): boolean {
  return /\.d\.(?:cts|mts|ts)$/.test(name);
}

export function isAuthoredTestPath(path: string): boolean {
  return /(?:^|[/\\])__tests__(?:[/\\]|$)/.test(path) || /\.(?:test|spec)\.[cm]?[jt]s$/.test(path);
}

export function isGeneratedSourceMapFileName(name: string): boolean {
  if (!name.endsWith(".map")) return false;
  const sourceFileName = name.slice(0, -".map".length);
  return (
    isTypeScriptDeclarationFileName(sourceFileName) ||
    getSupportedModuleBaseName(sourceFileName) !== null
  );
}

export function matchesSupportedModuleBaseName(name: string, baseName: string): boolean {
  return getSupportedModuleBaseName(name) === baseName;
}

export function stripLogicalPathExtension(input: string): string {
  const normalizedPath = normalizeLogicalPath(input);
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  const lastDotIndex = normalizedPath.lastIndexOf(".");

  if (lastDotIndex === -1 || lastDotIndex < lastSlashIndex) {
    return normalizedPath;
  }

  return normalizedPath.slice(0, lastDotIndex);
}
