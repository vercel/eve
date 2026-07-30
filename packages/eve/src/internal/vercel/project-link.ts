import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z } from "#compiled/zod/index.js";

export const VercelProjectLinkSchema = z.object({
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  projectName: z.string().min(1).optional(),
});

/** Validated Vercel owner and project identifiers from local link metadata. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;

const VercelRepoLinkProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  directory: z.string().min(1),
  orgId: z.string().min(1).optional(),
});

/**
 * The repo-level link the Vercel CLI writes to `<repoRoot>/.vercel/repo.json`
 * when a project is linked "by git" (a git remote matched to a git-connected
 * Vercel project). That flow never writes a folder-level `project.json`.
 * `orgId` lives per project or at the top level, depending on CLI version.
 */
export const VercelRepoLinkSchema = z.object({
  orgId: z.string().min(1).optional(),
  projects: z.array(VercelRepoLinkProjectSchema),
});

export type VercelRepoLink = z.infer<typeof VercelRepoLinkSchema>;

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * Selects the repo-link project that owns `relativePath` (POSIX-style, `"."`
 * for the repo root itself), mirroring the Vercel CLI's own matching: a
 * project matches when its `directory` is `"."`, equals the path, or is an
 * ancestor of it; the deepest directory wins. Returns `undefined` when nothing
 * matches, when the deepest directory is shared by several projects (the CLI
 * prompts in that case; a silent read cannot), or when no org id is resolvable.
 */
export function resolveRepoLinkProject(
  repoLink: VercelRepoLink,
  relativePath: string,
): VercelProjectLink | undefined {
  const matches = repoLink.projects
    .filter(
      (project) =>
        project.directory === "." ||
        relativePath === project.directory ||
        relativePath.startsWith(`${project.directory}/`),
    )
    .sort(
      (a, b) =>
        (b.directory === "." ? 0 : b.directory.split("/").length) -
        (a.directory === "." ? 0 : a.directory.split("/").length),
    );
  const deepest = matches[0];
  if (deepest === undefined) return undefined;
  if (matches.some((match) => match !== deepest && match.directory === deepest.directory)) {
    return undefined;
  }
  const orgId = deepest.orgId ?? repoLink.orgId;
  if (orgId === undefined) return undefined;
  const link: VercelProjectLink = { projectId: deepest.id, orgId };
  if (deepest.name !== undefined) link.projectName = deepest.name;
  return link;
}

/**
 * Walks up from `projectPath` to the first directory holding
 * `.vercel/repo.json` (the CLI's repo root), stopping — like the CLI — before
 * the home directory or at the filesystem root. Any read or validation failure
 * resolves to "no link".
 */
async function readVercelRepoLink(projectPath: string): Promise<VercelProjectLink | undefined> {
  const home = homedir();
  for (let current = resolve(projectPath); current !== home; current = dirname(current)) {
    let raw: unknown;
    try {
      raw = await readJson(join(current, ".vercel", "repo.json"));
    } catch (error) {
      if (!isMissingPathError(error)) return undefined;
      if (dirname(current) === current) break;
      continue;
    }
    const parsed = VercelRepoLinkSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const relativePath = relative(current, resolve(projectPath)).split(sep).join("/") || ".";
    return resolveRepoLinkProject(parsed.data, relativePath);
  }
  return undefined;
}

/**
 * Reads a validated Vercel project link without mutating local project state.
 *
 * Prefers the folder-level `.vercel/project.json`; when absent, falls back to
 * the repo-level `.vercel/repo.json` the CLI writes for git-linked projects,
 * resolving the entry whose `directory` owns `projectPath`.
 */
export async function readVercelProjectLink(
  projectPath: string,
): Promise<VercelProjectLink | undefined> {
  try {
    const parsed = VercelProjectLinkSchema.safeParse(
      await readJson(join(projectPath, ".vercel", "project.json")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (!isMissingPathError(error)) return undefined;
  }
  return await readVercelRepoLink(projectPath);
}
