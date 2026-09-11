import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { classifyAgentRootEntry, getDirectoryEntryType } from "#discover/filesystem.js";
import { parseProjectName, PROJECT_NAME_ERROR } from "#setup/project-name.js";

import type { InitFailurePolicy } from "./init-recovery.js";
import { InitTargetError } from "./init-telemetry.js";

const ENVIRONMENT_ONLY_ENTRIES = new Set([
  ".DS_Store",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".git",
  ".idea",
  ".vscode",
]);

export type InitTarget =
  | {
      kind: "existing";
      projectPath: string;
    }
  | {
      createInPlace: boolean;
      failurePolicy: InitFailurePolicy;
      kind: "fresh";
      overwriteExisting: boolean;
      preservedEntries: readonly string[];
      projectName: string;
      projectPath: string;
    };

interface ResolveInitTargetInput {
  parentDirectory: string;
  target: string | undefined;
}

async function pathKind(path: string): Promise<"directory" | "missing" | "other"> {
  const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stats === undefined) return "missing";
  return stats.isDirectory() ? "directory" : "other";
}

function isEnvironmentOnly(entries: readonly string[]): boolean {
  return entries.every((entry) => ENVIRONMENT_ONLY_ENTRIES.has(entry));
}

async function isAgentRoot(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => {
    const kind = classifyAgentRootEntry(entry.name, getDirectoryEntryType(entry));
    return kind !== "unknown" && kind !== "ignored-directory" && kind !== "lib-directory";
  });
}

async function isExistingEveProject(
  projectPath: string,
  entries: readonly string[],
): Promise<boolean> {
  if (await isAgentRoot(projectPath)) return true;
  return (
    (entries.includes("package.json") || entries.includes("vercel.json")) &&
    entries.includes("agent") &&
    (await isAgentRoot(resolve(projectPath, "agent")))
  );
}

function listEntries(entries: readonly string[]): string {
  return entries.map((entry) => `  - ${entry}`).join("\n");
}

function assertTargetStaysWithinParent(
  parentPath: string,
  target: string | undefined,
  projectPath: string,
): void {
  if (target === undefined || isAbsolute(target)) return;
  const relativeTarget = relative(parentPath, projectPath);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new InitTargetError("target_invalid", PROJECT_NAME_ERROR);
  }
}

/** Classifies the target itself without walking ancestor projects. */
export async function resolveInitTarget(input: ResolveInitTargetInput): Promise<InitTarget> {
  const parentPath = resolve(input.parentDirectory);
  const targetProvided = input.target !== undefined;
  const projectPath = resolve(parentPath, input.target ?? ".");
  assertTargetStaysWithinParent(parentPath, input.target, projectPath);
  const createInPlace = projectPath === parentPath;
  let kind: Awaited<ReturnType<typeof pathKind>>;
  try {
    kind = await pathKind(projectPath);
  } catch {
    throw new InitTargetError("target_filesystem", "Could not access the initialization target.");
  }

  if (kind === "other") {
    throw new InitTargetError(
      "target_invalid",
      `Cannot initialize an agent because "${projectPath}" is not a directory.`,
    );
  }

  if (kind === "missing") {
    let projectName: string;
    try {
      projectName = parseProjectName(basename(projectPath));
    } catch (error) {
      throw new InitTargetError(
        "target_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      createInPlace: false,
      failurePolicy: "remove",
      kind: "fresh",
      overwriteExisting: false,
      preservedEntries: [],
      projectName,
      projectPath,
    };
  }

  let entries: string[];
  try {
    entries = (await readdir(projectPath)).sort();
  } catch {
    throw new InitTargetError("target_filesystem", "Could not read the initialization target.");
  }
  if (entries.length === 0 || isEnvironmentOnly(entries)) {
    let projectName: string;
    try {
      projectName = createInPlace ? "." : parseProjectName(basename(projectPath));
    } catch (error) {
      throw new InitTargetError(
        "target_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      createInPlace: createInPlace || entries.length > 0,
      failurePolicy: "clear",
      kind: "fresh",
      overwriteExisting: false,
      preservedEntries: entries,
      projectName,
      projectPath,
    };
  }

  if (await isExistingEveProject(projectPath, entries)) {
    throw new InitTargetError(
      "target_conflict",
      `An eve project already exists at "${projectPath}". Run an existing-project command from that directory instead.`,
    );
  }

  if (entries.includes("package.json")) {
    if (!targetProvided || input.target !== ".") {
      throw new InitTargetError(
        "target_conflict",
        `Adding eve to an existing package requires an explicit \`eve init .\` from "${projectPath}".`,
      );
    }
    return { kind: "existing", projectPath };
  }

  throw new InitTargetError(
    "target_conflict",
    `Cannot initialize an agent in the non-empty directory "${projectPath}". Move or remove these entries, or choose an empty target:\n${listEntries(entries)}`,
  );
}
