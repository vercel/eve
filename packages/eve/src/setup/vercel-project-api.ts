import { HumanActionRequiredError } from "#setup/human-action.js";
import { captureVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import { z } from "zod";

import { isForbiddenApiFailure } from "./vercel-api-failure.js";
import type { VercelProjectOperationOptions } from "./project-resolution.js";

export type { VercelProjectOperationOptions };

/** Shared deadline for Vercel project list and exact-lookup requests. */
export const VERCEL_PROJECT_REQUEST_TIMEOUT_MS = 15_000;

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

/** One ranked Vercel project search page and its optional continuation cursor. */
export interface VercelProjectSearchPage {
  readonly projects: VercelProjectListEntry[];
  readonly next?: number;
}

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
  .transform((data) => data.teams);

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

const VERCEL_TEAM_PAGE_LIMIT = 100;

function isUnsupportedTeamListFailure(failure: VercelCaptureFailure): boolean {
  const output = `${failure.stderr}\n${failure.stdout}`;
  return /(?:unknown|unexpected|invalid).*(?:--format|--limit)/iu.test(output);
}

function requireVercelCliUpgrade(failure: VercelCaptureFailure): never {
  throw new HumanActionRequiredError({
    kind: "vercel-cli-upgrade",
    command: "vercel upgrade",
    reason: `The installed Vercel CLI does not support the team-list options eve needs. ${failure.message} Upgrade it and retry.`,
  });
}

async function captureTeamPage(
  projectRoot: string,
  options: VercelProjectOperationOptions,
  args: string[],
): Promise<string> {
  const result = await captureVercel(args, { cwd: projectRoot, signal: options.signal });
  options.signal?.throwIfAborted();
  if (!result.ok) {
    if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
    if (isUnsupportedTeamListFailure(result.failure)) requireVercelCliUpgrade(result.failure);
    throw new Error(`Could not list Vercel teams. ${result.failure.message}`);
  }
  return result.stdout;
}

/** Lists up to the maximum 100 Vercel scopes supported by the CLI. */
export async function listTeams(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelTeamListEntry[]> {
  const stdout = await captureTeamPage(projectRoot, options, [
    "teams",
    "ls",
    "--format",
    "json",
    "--limit",
    String(VERCEL_TEAM_PAGE_LIMIT),
  ]);
  const parsed = VercelTeamPageSchema.safeParse(parseVercelJson(stdout, "teams"));
  if (!parsed.success) throw new Error("Could not read teams from Vercel CLI JSON output.");
  return parsed.data;
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
    timeoutMs: VERCEL_PROJECT_REQUEST_TIMEOUT_MS,
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

function projectSearchRank(project: VercelProjectListEntry, query: string): number {
  const name = project.name.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  return 2;
}

/** Ranks exact and prefix project-name matches ahead of substring matches. */
export function rankProjectSearchResults(
  projects: readonly VercelProjectListEntry[],
  query: string,
): VercelProjectListEntry[] {
  const search = query.trim();
  return [...projects].sort(
    (left, right) => projectSearchRank(left, search) - projectSearchRank(right, search),
  );
}

/** Searches one ranked Vercel project page and retains its continuation cursor. */
export async function searchProjects(
  projectRoot: string,
  team: string,
  query: string,
  options: VercelProjectOperationOptions & { readonly next?: number } = {},
): Promise<VercelProjectSearchPage> {
  const search = query.trim();
  if (search.length === 0) throw new Error("Project search query cannot be empty.");
  const page = await fetchProjectPage(projectRoot, team, { ...options, search });
  const projects = rankProjectSearchResults(page.items, search);
  return page.next === undefined ? { projects } : { projects, next: page.next };
}
