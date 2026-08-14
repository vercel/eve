import { access, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { createPrompter, type Prompter } from "#setup/prompter.js";
import { DiscoveryProjectResolutionError, resolveDiscoveryProject } from "#discover/project.js";

interface ApplicationRootDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

export interface ResolveCliApplicationRootDependencies {
  readonly createPrompter: () => Prompter;
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly readDirectory: (
    path: string,
    options: { readonly withFileTypes: true },
  ) => Promise<readonly ApplicationRootDirectoryEntry[]>;
  readonly resolveDiscoveryProject: typeof resolveDiscoveryProject;
}

const defaultDependencies: ResolveCliApplicationRootDependencies = {
  createPrompter,
  async pathExists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  readDirectory: readdir,
  resolveDiscoveryProject,
};

async function tryResolveApplicationRoot(
  path: string,
  dependencies: ResolveCliApplicationRootDependencies,
): Promise<string | undefined> {
  try {
    return (await dependencies.resolveDiscoveryProject(path)).appRoot;
  } catch (error) {
    if (error instanceof DiscoveryProjectResolutionError) return undefined;
    throw error;
  }
}

/** Finds the nearest enclosing eve application. */
export async function findCliApplicationRoot(
  cwd: string = process.cwd(),
  dependencies: ResolveCliApplicationRootDependencies = defaultDependencies,
): Promise<string | undefined> {
  return await tryResolveApplicationRoot(cwd, dependencies);
}

async function hasAuthoredPackageBoundary(
  appRoot: string,
  dependencies: ResolveCliApplicationRootDependencies,
): Promise<boolean> {
  let directory = appRoot;
  while (true) {
    if (await dependencies.pathExists(join(directory, "package.json"))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
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
  const roots = await Promise.all(
    directories.map(async (directory) => {
      const appRoot = await tryResolveApplicationRoot(directory, dependencies);
      if (appRoot !== directory) return undefined;
      return (await hasAuthoredPackageBoundary(appRoot, dependencies)) ? appRoot : undefined;
    }),
  );
  return roots.filter((root): root is string => root !== undefined);
}

function displayChildPath(cwd: string, path: string): string {
  return `./${relative(cwd, path).replaceAll("\\", "/")}`;
}

/** Resolves an enclosing or immediate-child eve application for a project-scoped command. */
export async function resolveCliApplicationRoot(
  cwd: string = process.cwd(),
  options: { readonly interactive?: boolean } = {},
  dependencies: ResolveCliApplicationRootDependencies = defaultDependencies,
): Promise<string> {
  const resolvedCwd = resolve(cwd);
  const enclosingRoot = await findCliApplicationRoot(resolvedCwd, dependencies);
  if (enclosingRoot !== undefined) return enclosingRoot;

  const childRoots = await findChildApplicationRoots(resolvedCwd, dependencies);
  if (childRoots.length === 0) return resolvedCwd;

  if (options.interactive !== true) {
    const candidates = childRoots
      .map((path) => `  - ${displayChildPath(resolvedCwd, path)}`)
      .join("\n");
    throw new Error(
      `Cannot choose an eve application without an interactive terminal. Run the command from inside one of these applications:\n${candidates}`,
    );
  }

  return await dependencies.createPrompter().select<string>({
    message: "Which eve application should run this command?",
    options: childRoots.map((path) => ({
      value: path,
      label: displayChildPath(resolvedCwd, path),
    })),
    initialValue: childRoots[0],
  });
}
