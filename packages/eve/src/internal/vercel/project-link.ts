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

const VercelRepoLinkSchema = z.object({
  orgId: z.string().min(1).optional(),
  projects: z.array(
    z.object({
      directory: z.string().min(1),
      id: z.string().min(1),
      name: z.string().min(1),
      orgId: z.string().min(1).optional(),
    }),
  ),
});

function normalizeDirectory(directory: string): string {
  return directory === "." ? directory : directory.replaceAll("\\", "/").replace(/\/+$/, "");
}

function resolveRepoProjectLink(
  repo: z.infer<typeof VercelRepoLinkSchema>,
  repoRoot: string,
  projectPath: string,
): VercelProjectLink | undefined {
  const path = normalizeDirectory(relative(repoRoot, projectPath));
  const matches = repo.projects
    .filter((project) => {
      const directory = normalizeDirectory(project.directory);
      return directory === "." || path === directory || path.startsWith(`${directory}/`);
    })
    .sort((left, right) => right.directory.length - left.directory.length);
  const project = matches[0];
  if (project === undefined) return undefined;
  if (matches.filter((candidate) => candidate.directory === project.directory).length !== 1) {
    return undefined;
  }
  const orgId = project.orgId ?? repo.orgId;
  return orgId === undefined
    ? undefined
    : { orgId, projectId: project.id, projectName: project.name };
}

async function readVercelRepoLink(projectPath: string): Promise<VercelProjectLink | undefined> {
  let directory = projectPath;
  while (true) {
    try {
      const raw = await readFile(join(directory, ".vercel", "repo.json"), "utf8");
      const parsed = VercelRepoLinkSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return resolveRepoProjectLink(parsed.data, directory, projectPath);
    } catch {}

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Reads a validated Vercel project link without mutating local project state. */
export async function readVercelProjectLink(
  projectPath: string,
): Promise<VercelProjectLink | undefined> {
  try {
    const raw = await readFile(join(projectPath, ".vercel", "project.json"), "utf8");
    const parsed = VercelProjectLinkSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  return await readVercelRepoLink(projectPath);
}
