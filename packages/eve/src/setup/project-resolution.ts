import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  readVercelProjectLink,
  type VercelProjectLink,
  VercelProjectLinkSchema,
} from "#internal/vercel/project-link.js";
import { captureVercel } from "./primitives/run-vercel.js";

/** Link and production-deployment status for a Vercel project directory. */
export type DeploymentState = "unlinked" | "linked" | "deployed";

/** Vercel project data resolved from local link metadata and the API. */
export interface DeploymentInfo {
  state: DeploymentState;
  projectId?: string;
  orgId?: string;
  productionUrl?: string;
}

const VercelProjectEnvironmentSchema = z.object({
  VERCEL_ORG_ID: VercelProjectLinkSchema.shape.orgId,
  VERCEL_PROJECT_ID: VercelProjectLinkSchema.shape.projectId,
});

/** Validated Vercel owner and project identifiers. */
export type VercelProjectReference = VercelProjectLink;

/** Parses the complete Vercel owner and project environment pair. */
export function projectReferenceFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): VercelProjectReference | undefined {
  const parsed = VercelProjectEnvironmentSchema.safeParse(environment);
  if (!parsed.success) return undefined;
  return {
    orgId: parsed.data.VERCEL_ORG_ID,
    projectId: parsed.data.VERCEL_PROJECT_ID,
  };
}

/** Rejects Vercel's unsupported legacy link directory before link mutation. */
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

/** Reads a validated project reference from Vercel's link metadata directory. */
export async function readProjectLink(
  projectPath: string,
): Promise<VercelProjectReference | undefined> {
  await assertNoLegacyProjectLinkDirectory(projectPath);
  return await readVercelProjectLink(projectPath);
}

interface VercelApiProject {
  targets?: { production?: { alias?: unknown } };
}

/** Cancellation options shared by Vercel project read/operation helpers. */
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

/**
 * Reads local Vercel link metadata and checks whether the linked project has a production alias.
 */
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

/** Human-readable identity of a linked Vercel project, for the dashboard status bar. */
export interface ProjectIdentity {
  projectName: string;
  /** The team's display name; absent for a personal-account project. */
  teamName?: string;
}

interface VercelApiNamed {
  name?: unknown;
  slug?: unknown;
}

/** Reads a `name` (or `slug` fallback) off a Vercel API resource, or undefined. */
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
    const parsed = JSON.parse(result.stdout) as VercelApiNamed;
    if (typeof parsed.name === "string" && parsed.name.length > 0) return parsed.name;
    if (typeof parsed.slug === "string" && parsed.slug.length > 0) return parsed.slug;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a linked project's human-readable name and team for the dashboard
 * status bar, from local `.vercel/project.json` plus the Vercel API. A
 * personal-account project (a non-`team_` org) carries no team, so `teamName`
 * is absent; the project name falls back to its id if the API call fails.
 *
 * Returns `undefined` when the directory is not linked. Network-bound: callers
 * render a loading affordance and cache the result.
 *
 * @param projectPath Absolute path of the linked project directory.
 */
export async function detectProjectIdentity(
  projectPath: string,
  options: VercelProjectOperationOptions = {},
): Promise<ProjectIdentity | undefined> {
  options.signal?.throwIfAborted();
  const link = await readProjectLink(projectPath);
  if (link === undefined) return undefined;

  // Independent lookups; fetched concurrently because this read gates the
  // first paint of every surface that names the link (/model, the dashboard).
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

/**
 * Side-effect-free fact gathering after a link: reads `.vercel/project.json`
 * to resolve the project. The on-disk link is the single source of truth.
 */
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
