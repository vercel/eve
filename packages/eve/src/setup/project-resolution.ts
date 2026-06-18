import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

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

const VercelProjectLinkSchema = z.object({
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  projectName: z.string().min(1).optional(),
});

/** Project and team identifiers from a valid on-disk Vercel link. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;

interface ResolvedVercelProjectLink extends VercelProjectLink {
  readonly projectName: string;
}

interface WriteProjectLinkInput {
  readonly projectRoot: string;
  readonly link: ResolvedVercelProjectLink;
  readonly signal?: AbortSignal;
}

const VERCEL_DIRECTORY_README = `> Why do I have a folder named ".vercel" in my project?
The ".vercel" folder is created when you link a directory to a Vercel project.

> What does the "project.json" file contain?
The "project.json" file contains:
- The ID of the Vercel project that you linked ("projectId")
- The ID of the user or team your Vercel project is owned by ("orgId")

> Should I commit the ".vercel" folder?
No, you should not share the ".vercel" folder with anyone.
Upon creation, it will be automatically added to your ".gitignore" file.
`;

async function ensureVercelIgnored(
  projectRoot: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    const path = join(projectRoot, ".gitignore");
    const current = await readFile(path, "utf8").catch(() => "");
    const newline = current.includes("\r\n") ? "\r\n" : "\n";
    if (current.split(/\r?\n/u).includes(".vercel")) return;
    const separator = current.length === 0 || current.endsWith(newline) ? "" : newline;
    await writeFile(path, `${current}${separator}.vercel${newline}`, { encoding: "utf8", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    // Match `vercel link`: the project link remains valid when updating the
    // auxiliary ignore file is not possible.
  }
}

/** Writes the Vercel CLI's project-scoped link files without invoking plugin onboarding. */
export async function writeProjectLink(input: WriteProjectLinkInput): Promise<void> {
  input.signal?.throwIfAborted();
  const vercelDirectory = join(input.projectRoot, ".vercel");
  await mkdir(vercelDirectory, { recursive: true });
  input.signal?.throwIfAborted();
  await writeFile(
    join(vercelDirectory, "project.json"),
    `${JSON.stringify(input.link, null, 2)}\n`,
    { encoding: "utf8", signal: input.signal },
  );
  await writeFile(join(vercelDirectory, "README.txt"), VERCEL_DIRECTORY_README, {
    encoding: "utf8",
    signal: input.signal,
  });
  await ensureVercelIgnored(input.projectRoot, input.signal);
}

/** Reads the linked Vercel project and team ids from `.vercel/project.json`. */
export async function readProjectLink(projectPath: string): Promise<VercelProjectLink | undefined> {
  try {
    const raw = await readFile(join(projectPath, ".vercel", "project.json"), "utf8");
    const parsed = VercelProjectLinkSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface VercelApiProject {
  targets?: { production?: { alias?: unknown } };
}

export interface ProjectDetectionOptions {
  signal?: AbortSignal;
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
  options: ProjectDetectionOptions,
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
  options: ProjectDetectionOptions = {},
): Promise<DeploymentInfo> {
  options.signal?.throwIfAborted();
  const link = await readProjectLink(projectPath);
  if (link === undefined) return { state: "unlinked" };
  const { projectId, orgId } = link;

  const productionUrl = await fetchProductionAlias(projectId, orgId, projectPath, options);
  options.signal?.throwIfAborted();
  return {
    state: productionUrl ? "deployed" : "linked",
    projectId,
    orgId,
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
  options: ProjectDetectionOptions,
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
  options: ProjectDetectionOptions = {},
): Promise<ProjectIdentity | undefined> {
  options.signal?.throwIfAborted();
  const link = await readProjectLink(projectPath);
  if (link === undefined) return undefined;
  const { projectId, orgId } = link;

  // Independent lookups; fetched concurrently because this read gates the
  // first paint of every surface that names the link (/model, the dashboard).
  const [projectName, teamName] = await Promise.all([
    fetchVercelName(`/v9/projects/${projectId}?teamId=${orgId}`, orgId, projectPath, options).then(
      (name) => name ?? projectId,
    ),
    orgId.startsWith("team_")
      ? fetchVercelName(`/v2/teams/${orgId}`, orgId, projectPath, options)
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
  options: ProjectDetectionOptions = {},
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
