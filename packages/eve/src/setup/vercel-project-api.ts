import { HumanActionRequiredError } from "#setup/human-action.js";
import { captureVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import { z } from "zod";

import { isForbiddenApiFailure } from "./vercel-api-failure.js";
import type { VercelProjectOperationOptions } from "./project-resolution.js";

export type { VercelProjectOperationOptions };

const PROJECT_LIST_TIMEOUT_MS = 15_000;

const VercelTeamListEntrySchema = z.object({
  name: z.string(),
  slug: z.string(),
  current: z.boolean(),
});

type VercelTeamListEntry = z.infer<typeof VercelTeamListEntrySchema>;

const VercelProjectListEntrySchema = z.object({
  name: z.string(),
  id: z.string(),
});

export type VercelProjectListEntry = z.infer<typeof VercelProjectListEntrySchema>;

const VercelPaginationSchema = z.object({
  next: z.number().int().nonnegative().nullable().optional(),
});

/** One drained page of a cursor-paginated Vercel list. */
interface VercelPage<T> {
  readonly items: T[];
  readonly next?: number;
}

const VercelTeamPageSchema = z
  .object({
    teams: z.array(VercelTeamListEntrySchema),
    pagination: VercelPaginationSchema.optional(),
  })
  .transform((data) => ({ items: data.teams, next: data.pagination?.next ?? undefined }));

const VercelProjectPageSchema = z
  .object({
    projects: z.array(VercelProjectListEntrySchema),
    pagination: VercelPaginationSchema.optional(),
  })
  .transform((data) => ({ items: data.projects, next: data.pagination?.next ?? undefined }));

/** Parses one JSON response captured from the Vercel CLI. */
export function parseVercelJson(stdout: string, description: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse ${description} JSON from Vercel CLI output.`);
  }
}

/**
 * Drains a cursor-paginated Vercel list, deduping by `key`. A repeated cursor
 * means Vercel paged us in a circle — bail rather than loop forever.
 */
async function drainPages<T>(
  label: string,
  key: (item: T) => string,
  fetchPage: (next: number | undefined) => Promise<VercelPage<T>>,
): Promise<T[]> {
  const items = new Map<string, T>();
  const cursors = new Set<number>();
  let next: number | undefined;
  while (true) {
    const page = await fetchPage(next);
    for (const item of page.items) items.set(key(item), item);
    if (page.next === undefined) return [...items.values()];
    if (cursors.has(page.next)) {
      throw new Error(`Vercel returned a repeated pagination cursor for ${label}.`);
    }
    cursors.add(page.next);
    next = page.next;
  }
}

/** Converts a scoped API denial into the Vercel re-authentication action. */
export function requireVercelTeamAccess(failure: VercelCaptureFailure): never {
  const stderr = failure.stderr.trim();
  const detail = stderr ? ` ${stderr}` : "";
  throw new HumanActionRequiredError({
    kind: "vercel-forbidden",
    command: "vercel login",
    reason: `Vercel denied access to this scope.${detail} Re-authenticate (for example to complete a team's SSO) or switch to a team you can access.`,
  });
}

async function fetchTeamPage(
  projectRoot: string,
  options: VercelProjectOperationOptions,
  next: number | undefined,
): Promise<VercelPage<VercelTeamListEntry>> {
  const args = ["teams", "ls", "--format", "json"];
  if (next !== undefined) args.push("--next", String(next));
  const result = await captureVercel(args, { cwd: projectRoot, signal: options.signal });
  options.signal?.throwIfAborted();
  if (!result.ok) {
    if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
    throw new Error(`Could not list Vercel teams. ${result.failure.message}`);
  }
  const parsed = VercelTeamPageSchema.safeParse(parseVercelJson(result.stdout, "teams"));
  if (!parsed.success) throw new Error("Could not read teams from Vercel CLI JSON output.");
  return parsed.data;
}

/** Lists every Vercel scope available to the current CLI user. */
export async function listTeams(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelTeamListEntry[]> {
  return drainPages(
    "Vercel teams",
    (team) => team.slug,
    (next) => fetchTeamPage(projectRoot, options, next),
  );
}

async function fetchProjectPage(
  projectRoot: string,
  team: string,
  options: VercelProjectOperationOptions & { readonly search?: string; readonly next?: number },
): Promise<VercelPage<VercelProjectListEntry>> {
  const args = ["project", "ls", "--format", "json", "--scope", team];
  if (options.search !== undefined) args.push("--filter", options.search);
  if (options.next !== undefined) args.push("--next", String(options.next));
  const result = await captureVercel(args, {
    cwd: projectRoot,
    signal: options.signal,
    timeoutMs: PROJECT_LIST_TIMEOUT_MS,
  });
  options.signal?.throwIfAborted();
  if (!result.ok) {
    if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
    throw new Error(`Could not list Vercel projects in ${team}. ${result.failure.message}`);
  }
  const parsed = VercelProjectPageSchema.safeParse(parseVercelJson(result.stdout, "projects"));
  if (!parsed.success) throw new Error("Could not read projects from Vercel CLI JSON output.");
  return parsed.data;
}

/** Lists the 20 most recent Vercel projects in one account scope. */
export async function listRecentProjects(
  projectRoot: string,
  team: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelProjectListEntry[]> {
  return (await fetchProjectPage(projectRoot, team, options)).items;
}

/** Searches every matching Vercel project page in one account scope. */
export async function searchProjects(
  projectRoot: string,
  team: string,
  query: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelProjectListEntry[]> {
  const search = query.trim();
  if (search.length === 0) throw new Error("Project search query cannot be empty.");
  return drainPages(
    `project search in ${team}`,
    (project) => project.id,
    (next) => fetchProjectPage(projectRoot, team, { ...options, search, next }),
  );
}
