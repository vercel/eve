import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { z } from "#compiled/zod/index.js";

export const VercelProjectLinkSchema = z.object({
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  projectName: z.string().min(1).optional(),
});

/** Validated Vercel owner and project identifiers from Vercel link metadata. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;

const VercelRepoProjectSchema = z.object({
  directory: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  orgId: z.string().min(1).optional(),
});

const VercelRepoLinkSchema = z.object({
  orgId: z.string().min(1).optional(),
  projects: z.array(VercelRepoProjectSchema),
});

type VercelRepoLink = z.infer<typeof VercelRepoLinkSchema>;

function normalizeDirectory(directory: string): string {
  return directory === "." ? directory : directory.replaceAll("\\", "/").replace(/\/+$/, "");
}

function containsDirectory(directory: string, path: string): boolean {
  return directory === "." || path === directory || path.startsWith(`${directory}/`);
}

function resolveRepoProject(
  repo: VercelRepoLink,
  repoRoot: string,
  projectPath: string,
): VercelProjectLink | undefined {
  const path = normalizeDirectory(relative(repoRoot, projectPath));
  const matches = repo.projects.filter((project) =>
    containsDirectory(normalizeDirectory(project.directory), path),
  );
  const deepestDirectoryLength = Math.max(...matches.map((project) => project.directory.length));
  const deepestMatches = matches.filter(
    (project) => project.directory.length === deepestDirectoryLength,
  );
  const project = deepestMatches.length === 1 ? deepestMatches[0] : undefined;
  if (project === undefined) return undefined;

  const orgId = project.orgId ?? repo.orgId;
  return orgId === undefined
    ? undefined
    : { orgId, projectId: project.id, projectName: project.name };
}

async function readProjectFile(projectPath: string): Promise<VercelProjectLink | undefined> {
  try {
    const raw = await readFile(join(projectPath, ".vercel", "project.json"), "utf8");
    const parsed = VercelProjectLinkSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readRepoFile(repoRoot: string): Promise<VercelRepoLink | undefined> {
  try {
    const raw = await readFile(join(repoRoot, ".vercel", "repo.json"), "utf8");
    const parsed = VercelRepoLinkSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readRepoProjectLink(projectPath: string): Promise<VercelProjectLink | undefined> {
  let repoRoot = projectPath;
  while (true) {
    const repo = await readRepoFile(repoRoot);
    if (repo !== undefined) return resolveRepoProject(repo, repoRoot, projectPath);

    const parent = dirname(repoRoot);
    if (parent === repoRoot) return undefined;
    repoRoot = parent;
  }
}

/** Reads a validated Vercel project link without mutating local project state. */
export async function readVercelProjectLink(
  projectPath: string,
): Promise<VercelProjectLink | undefined> {
  return (await readProjectFile(projectPath)) ?? (await readRepoProjectLink(projectPath));
}
