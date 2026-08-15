import { resolve } from "node:path";

import { DiscoveryProjectResolutionError, resolveDiscoveryProject } from "#discover/project.js";

export interface ResolveCliApplicationRootDependencies {
  readonly resolveDiscoveryProject: typeof resolveDiscoveryProject;
}

const defaultDependencies: ResolveCliApplicationRootDependencies = {
  resolveDiscoveryProject,
};

/** Finds the nearest enclosing eve application. */
export async function findCliApplicationRoot(
  cwd: string = process.cwd(),
  dependencies: ResolveCliApplicationRootDependencies = defaultDependencies,
): Promise<string | undefined> {
  try {
    return (await dependencies.resolveDiscoveryProject(cwd)).appRoot;
  } catch (error) {
    if (error instanceof DiscoveryProjectResolutionError) return undefined;
    throw error;
  }
}

/** Uses the nearest enclosing eve application, or preserves cwd when none exists. */
export async function resolveCliApplicationRoot(
  cwd: string = process.cwd(),
  dependencies: ResolveCliApplicationRootDependencies = defaultDependencies,
): Promise<string> {
  return (await findCliApplicationRoot(cwd, dependencies)) ?? resolve(cwd);
}
