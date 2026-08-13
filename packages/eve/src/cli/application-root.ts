import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { createPrompter, type Prompter } from "#setup/prompter.js";
import { isEveProject } from "#setup/scaffold/index.js";

interface ApplicationRootDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

export interface ResolveCliApplicationRootDependencies {
  readonly createPrompter: () => Prompter;
  readonly isEveProject: (path: string) => Promise<boolean>;
  readonly readDirectory: (
    path: string,
    options: { readonly withFileTypes: true },
  ) => Promise<readonly ApplicationRootDirectoryEntry[]>;
}

const defaultDependencies: ResolveCliApplicationRootDependencies = {
  createPrompter,
  isEveProject,
  readDirectory: readdir,
};

function displayChildPath(cwd: string, path: string): string {
  return `./${relative(cwd, path).replaceAll("\\", "/")}`;
}

async function findNearestApplicationRoot(
  cwd: string,
  isProject: ResolveCliApplicationRootDependencies["isEveProject"],
): Promise<string | undefined> {
  let candidate = cwd;
  while (true) {
    if (await isProject(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function findChildApplicationRoots(
  cwd: string,
  dependencies: ResolveCliApplicationRootDependencies,
): Promise<string[]> {
  const entries = await dependencies.readDirectory(cwd, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(cwd, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const matches = await Promise.all(
    directories.map(async (path) => ((await dependencies.isEveProject(path)) ? path : undefined)),
  );
  return matches.filter((path): path is string => path !== undefined);
}

/** Resolves the eve application a project-scoped CLI command should operate on. */
export async function resolveCliApplicationRoot(
  cwd: string = process.cwd(),
  options: { readonly interactive?: boolean } = {},
  dependencies: ResolveCliApplicationRootDependencies = defaultDependencies,
): Promise<string> {
  const resolvedCwd = resolve(cwd);
  const ancestor = await findNearestApplicationRoot(resolvedCwd, dependencies.isEveProject);
  if (ancestor !== undefined) return ancestor;

  const children = await findChildApplicationRoots(resolvedCwd, dependencies);
  if (children.length === 0) {
    throw new Error(
      "No eve application found in this directory, its ancestors, or its immediate subdirectories.",
    );
  }

  if (options.interactive !== true) {
    const candidates = children
      .map((path) => `  - ${displayChildPath(resolvedCwd, path)}`)
      .join("\n");
    throw new Error(
      `Cannot choose an eve application without an interactive terminal. Run the command from inside one of these applications:\n${candidates}`,
    );
  }

  return await dependencies.createPrompter().select<string>({
    message: "Which eve application should run this command?",
    description: "Found eve applications in immediate subdirectories.",
    options: children.map((path) => ({
      value: path,
      label: displayChildPath(resolvedCwd, path),
    })),
    initialValue: children[0],
  });
}
