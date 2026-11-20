import {
  DiscoveryProjectResolutionError,
  resolveDiscoveryProject,
  type ResolvedDiscoveryProject,
} from "#discover/project.js";

export async function resolveCliApplicationProject(
  cwd: string = process.cwd(),
): Promise<ResolvedDiscoveryProject> {
  return resolveDiscoveryProject(cwd);
}

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
