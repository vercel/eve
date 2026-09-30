import {
  DiscoveryProjectResolutionError,
  resolveDiscoveryProject,
  type ResolvedDiscoveryProject,
} from "#discover/project.js";

/** Resolves the nearest enclosing eve application and agent roots. */
export async function resolveCliApplicationProject(
  cwd: string = process.cwd(),
): Promise<ResolvedDiscoveryProject> {
  return resolveDiscoveryProject(cwd);
}

/** Finds the nearest enclosing eve application. */
export async function findCliApplicationRoot(
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  try {
    return (await resolveDiscoveryProject(cwd)).appRoot;
  } catch (error) {
    if (error instanceof DiscoveryProjectResolutionError) return undefined;
    throw error;
  }
}
