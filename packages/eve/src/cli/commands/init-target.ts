import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { pathExists } from "#setup/path-exists.js";
import { parseProjectName } from "#setup/project-name.js";
import { blockingCreateInPlaceEntries } from "#setup/scaffold/create-in-place.js";

import type { InitNonEmptyDirectoryTarget } from "./init-confirm.js";
import type { InitFailurePolicy } from "./init-recovery.js";

const CURRENT_DIRECTORY_PROJECT_NAME = ".";

export type InitTarget =
  | {
      kind: "existing";
      projectPath: string;
    }
  | {
      failurePolicy: InitFailurePolicy;
      kind: "fresh";
      overwriteExisting: boolean;
      preservedEntries: readonly string[];
      projectName: string;
      projectPath: string;
    };

interface ResolveInitTargetInput {
  agentLaunched: boolean;
  confirmInitInNonEmptyDirectory(entries: readonly string[]): Promise<InitNonEmptyDirectoryTarget>;
  parentDirectory: string;
  target: string | undefined;
}

function isCurrentDirectoryTarget(target: string): boolean {
  return /^\.(?:[/\\]+\.?)*$/u.test(target.trim());
}

async function resolveNamedTarget(parentPath: string, rawTarget: string): Promise<InitTarget> {
  const projectName = parseProjectName(rawTarget);
  const projectPath = join(parentPath, projectName);
  const stats = await stat(projectPath).then(
    (result) => result,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (stats === undefined) {
    return {
      failurePolicy: "remove",
      kind: "fresh",
      overwriteExisting: false,
      preservedEntries: [],
      projectName,
      projectPath,
    };
  }
  if (!stats.isDirectory()) {
    throw new Error(`Cannot create project because "${projectPath}" already exists.`);
  }

  const entries = await readdir(projectPath);
  if (entries.length > 0) {
    return { kind: "existing", projectPath };
  }
  return {
    failurePolicy: "clear",
    kind: "fresh",
    overwriteExisting: false,
    preservedEntries: [],
    projectName,
    projectPath,
  };
}

export async function resolveInitTarget(input: ResolveInitTargetInput): Promise<InitTarget> {
  const parentPath = resolve(input.parentDirectory);
  const rawTarget = input.target ?? CURRENT_DIRECTORY_PROJECT_NAME;
  if (!isCurrentDirectoryTarget(rawTarget)) {
    return resolveNamedTarget(parentPath, rawTarget);
  }

  if (await pathExists(join(parentPath, "package.json"))) {
    return { kind: "existing", projectPath: parentPath };
  }

  const entries = await readdir(parentPath);
  const blocking = blockingCreateInPlaceEntries(entries);
  if (blocking.length === 0) {
    return {
      failurePolicy: "clear",
      kind: "fresh",
      overwriteExisting: false,
      preservedEntries: entries,
      projectName: CURRENT_DIRECTORY_PROJECT_NAME,
      projectPath: parentPath,
    };
  }
  if (input.agentLaunched) {
    throw new Error(
      "Coding-agent launches cannot choose where to initialize a non-empty current directory. Pass a new directory name, for example: eve init my-agent.",
    );
  }

  const selection = await input.confirmInitInNonEmptyDirectory(blocking);
  if (selection.kind === "subdirectory") {
    return resolveNamedTarget(parentPath, selection.name);
  }
  return {
    failurePolicy: "preserve",
    kind: "fresh",
    overwriteExisting: true,
    preservedEntries: entries,
    projectName: CURRENT_DIRECTORY_PROJECT_NAME,
    projectPath: parentPath,
  };
}
