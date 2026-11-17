import { stat } from "node:fs/promises";
import { join } from "node:path";

import { readVercelProjectLink, type VercelProjectLink } from "#internal/vercel/project-link.js";
import { readVercelResourceName } from "#internal/vercel/api-resource.js";
import { captureVercel } from "./primitives/run-vercel.js";

export type DeploymentState = "unlinked" | "linked" | "deployed";

export interface DeploymentInfo {
  state: DeploymentState;
  projectId?: string;
  orgId?: string;
  productionUrl?: string;
}

export type VercelProjectReference = VercelProjectLink;

export async function assertNoLegacyProjectLinkDirectory(projectRoot: string): Promise<void> {
  try {
    if (!(await stat(join(projectRoot, ".now"))).isDirectory()) return;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  throw new Error(
    "Legacy Vercel link directory `.now` is not supported. Remove `.now` before linking this project.",
  );
}

export async function readProjectLink(
  projectPath: string,
): Promise<VercelProjectReference | undefined> {
  await assertNoLegacyProjectLinkDirectory(projectPath);
  return await readVercelProjectLink(projectPath);
}

interface VercelApiProject {
  targets?: { production?: { alias?: unknown } };
}

export interface VercelProjectOperationOptions {
  readonly signal?: AbortSignal;
}

function pickShortestAlias(aliases: unknown): string | undefined {
  if (!Array.isArray(aliases)) return undefined;
  let shortest: string | undefined;
  for (const alias of aliases) {
    if (typeof alias !== "string" || alias.length === 0) continue;
    if (shortest === undefined || alias.length < shortest.length) {
      shortest = alias;
    }
  }
  return shortest;
}

async function fetchProductionAlias(
  projectId: string,
  orgId: string,
  projectPath: string,
  options: VercelProjectOperationOptions,
): Promise<string | undefined> {
  const result = await captureVercel(
    ["api", `/v9/projects/${projectId}?teamId=${orgId}`, "--scope", orgId],
    { cwd: projectPath, signal: options.signal },
  );
  if (!result.ok) return undefined;

  try {
    const parsed = JSON.parse(result.stdout) as VercelApiProject;
    const alias = pickShortestAlias(parsed.targets?.production?.alias);
    return alias ? `https://${alias}` : undefined;
  } catch {
    return undefined;
  }
}

export async function detectDeployment(
  projectPath: string,
  options: VercelProjectOperationOptions = {},
): Promise<DeploymentInfo> {
  options.signal?.throwIfAborted();
  const link = await readProjectLink(projectPath);
  if (link === undefined) return { state: "unlinked" };

  const productionUrl = await fetchProductionAlias(
    link.projectId,
    link.orgId,
    projectPath,
    options,
  );
  options.signal?.throwIfAborted();
  return {
    state: productionUrl ? "deployed" : "linked",
    projectId: link.projectId,
    orgId: link.orgId,
    productionUrl,
  };
}

export interface ProjectIdentity {
  projectName: string;
  teamName?: string;
}

async function fetchVercelName(
  apiPath: string,
  orgId: string,
  projectPath: string,
  options: VercelProjectOperationOptions,
): Promise<string | undefined> {
  const result = await captureVercel(["api", apiPath, "--scope", orgId], {
    cwd: projectPath,
    signal: options.signal,
  });
  if (!result.ok) return undefined;
  try {
    return readVercelResourceName(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export async function detectProjectIdentity(
  projectPath: string,
  options: VercelProjectOperationOptions = {},
): Promise<ProjectIdentity | undefined> {
  options.signal?.throwIfAborted();
  const link = await readProjectLink(projectPath);
  if (link === undefined) return undefined;

  const [projectName, teamName] = await Promise.all([
    fetchVercelName(
      `/v9/projects/${link.projectId}?teamId=${link.orgId}`,
      link.orgId,
      projectPath,
      options,
    ).then((name) => name ?? link.projectId),
    link.orgId.startsWith("team_")
      ? fetchVercelName(`/v2/teams/${link.orgId}`, link.orgId, projectPath, options)
      : Promise.resolve(undefined),
  ]);
  options.signal?.throwIfAborted();
  return { projectName, teamName };
}

export type ProjectResolution =
  | { kind: "unresolved" }
  | { kind: "linked"; projectId: string }
  | { kind: "deployed"; projectId: string; productionUrl: string };

export function projectResolutionFromDeployment(deployment: DeploymentInfo): ProjectResolution {
  if (deployment.state === "unlinked" || deployment.projectId === undefined) {
    return { kind: "unresolved" };
  }
  if (deployment.state === "deployed" && deployment.productionUrl !== undefined) {
    return {
      kind: "deployed",
      projectId: deployment.projectId,
      productionUrl: deployment.productionUrl,
    };
  }
  return { kind: "linked", projectId: deployment.projectId };
}

export async function detectProjectResolution(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<ProjectResolution> {
  return projectResolutionFromDeployment(await detectDeployment(projectRoot, options));
}

export function mergeProjectResolution(
  current: ProjectResolution,
  next: ProjectResolution,
): ProjectResolution {
  if (next.kind === "unresolved") return current;
  if (current.kind === "deployed" && current.projectId === next.projectId) return current;
  return next;
}

export function projectResolutionFromDeployResult(
  project: ProjectResolution,
  deploy: { deployed: boolean; productionUrl?: string },
): ProjectResolution {
  if (project.kind === "unresolved") return project;
  if (!deploy.deployed || deploy.productionUrl === undefined) return project;
  return {
    kind: "deployed",
    projectId: project.projectId,
    productionUrl: deploy.productionUrl,
  };
}

export function isProjectResolved(project: ProjectResolution): boolean {
  return project.kind !== "unresolved";
}

export function projectProductionUrlFromResolution(project: ProjectResolution): string | undefined {
  return project.kind === "deployed" ? project.productionUrl : undefined;
}
