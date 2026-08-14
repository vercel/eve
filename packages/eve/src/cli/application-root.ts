import { resolve } from "node:path";

import {
  DiscoveryProjectResolutionError,
  resolveDiscoveryProject,
  type ResolvedDiscoveryProject,
} from "#discover/project.js";

export interface ResolveCliApplicationRootDependencies {
  readonly resolveDiscoveryProject: typeof resolveDiscoveryProject;
}

const defaultDependencies: ResolveCliApplicationRootDependencies = {
  resolveDiscoveryProject,
};

/** Resolves the nearest enclosing eve application and agent roots. */
export async function resolveCliApplicationProject(
  cwd: string = process.cwd(),
  dependencies: ResolveCliApplicationRootDependencies = defaultDependencies,
): Promise<ResolvedDiscoveryProject> {
  return dependencies.resolveDiscoveryProject(cwd);
}

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
