import { HumanActionRequiredError } from "#setup/human-action.js";
import { captureVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import { z } from "zod";

const VERCEL_PROJECTS_API_PATH = "/v9/projects?limit=20";
const PROJECT_LIST_TIMEOUT_MS = 15_000;

const VercelApiErrorSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const VercelTeamListEntrySchema = z.object({
  name: z.string(),
  slug: z.string(),
  current: z.boolean(),
});

type VercelTeamListEntry = z.infer<typeof VercelTeamListEntrySchema>;

const VercelProjectListEntrySchema = z.object({
  name: z.string(),
  id: z.string(),
  updatedAt: z.number(),
});

export type VercelProjectListEntry = z.infer<typeof VercelProjectListEntrySchema>;

const VercelPaginationSchema = z.object({
  next: z.number().int().nonnegative().nullable().optional(),
});

const VercelTeamPageSchema = z.object({
  teams: z.array(VercelTeamListEntrySchema),
  pagination: VercelPaginationSchema.optional(),
});

const VercelProjectPageSchema = z.object({
  projects: z.array(VercelProjectListEntrySchema),
  pagination: VercelPaginationSchema.optional(),
});

interface VercelTeamPage {
  readonly teams: VercelTeamListEntry[];
  readonly next?: number;
}

interface VercelProjectPage {
  readonly projects: VercelProjectListEntry[];
  readonly next?: number;
}

export interface VercelProjectOperationOptions {
  readonly signal?: AbortSignal;
}

/** Parses a JSON response captured from the Vercel CLI. */
export function parseVercelJson(stdout: string, description: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse ${description} JSON from Vercel CLI output.`);
  }
}

function parseTeamPage(stdout: string): VercelTeamPage {
  const parsed = VercelTeamPageSchema.safeParse(parseVercelJson(stdout, "teams"));
  if (!parsed.success) {
    throw new Error("Could not read teams from Vercel CLI JSON output.");
  }
  const next = parsed.data.pagination?.next;
  return next === null || next === undefined
    ? { teams: parsed.data.teams }
    : { teams: parsed.data.teams, next };
}

function projectsApiPath(search: string | undefined, until: number | undefined): string {
  let path = VERCEL_PROJECTS_API_PATH;
  if (search !== undefined) path += `&search=${encodeURIComponent(search)}`;
  if (until !== undefined) path += `&until=${until}`;
  return path;
}

function parseProjectPage(stdout: string): VercelProjectPage {
  const parsed = VercelProjectPageSchema.safeParse(parseVercelJson(stdout, "projects"));
  if (!parsed.success) {
    throw new Error("Could not read projects from Vercel CLI JSON output.");
  }
  const next = parsed.data.pagination?.next;
  return next === null || next === undefined
    ? { projects: parsed.data.projects }
    : { projects: parsed.data.projects, next };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Validates JSON captured from the Vercel CLI against a schema, or `undefined`. */
export function parseVercelJsonAs<T>(stdout: string, schema: z.ZodType<T>): T | undefined {
  const parsed = schema.safeParse(safeParseJson(stdout));
  return parsed.success ? parsed.data : undefined;
}

function apiFailureText(failure: VercelCaptureFailure): string {
  const parsed = VercelApiErrorSchema.safeParse(safeParseJson(failure.stdout));
  const error = parsed.success ? parsed.data.error : undefined;
  return `${error?.code ?? ""} ${error?.message ?? ""} ${failure.stdout} ${failure.stderr}`.toLowerCase();
}

/** Whether a Vercel API failure says the requested resource does not exist. */
export function isNotFoundApiFailure(failure: VercelCaptureFailure): boolean {
  return failure.code === 404 || /not_found|not found|404/.test(apiFailureText(failure));
}

/** Whether a Vercel API failure reports a conflicting existing resource. */
export function isConflictApiFailure(failure: VercelCaptureFailure): boolean {
  return /409|conflict|already exists/.test(apiFailureText(failure));
}

/** A scoped API denial, commonly caused by team SSO or missing membership. */
export function isForbiddenApiFailure(failure: VercelCaptureFailure): boolean {
  return /403|forbidden|not_authorized|not authorized|sso|saml/.test(apiFailureText(failure));
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

/** Lists the Vercel scopes available to the current CLI user. */
export async function listTeams(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelTeamListEntry[]> {
  const teams = new Map<string, VercelTeamListEntry>();
  const cursors = new Set<number>();
  let next: number | undefined;
  while (true) {
    const args = ["teams", "ls", "--format", "json"];
    if (next !== undefined) args.push("--next", String(next));
    const result = await captureVercel(args, {
      cwd: projectRoot,
      signal: options.signal,
    });
    if (!result.ok) {
      if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
      throw new Error(`Could not list Vercel teams. ${result.failure.message}`);
    }
    const page = parseTeamPage(result.stdout);
    for (const team of page.teams) {
      if (!teams.has(team.slug)) teams.set(team.slug, team);
    }
    if (page.next === undefined) return [...teams.values()];
    if (cursors.has(page.next)) {
      throw new Error("Vercel returned a repeated pagination cursor for Vercel teams.");
    }
    cursors.add(page.next);
    next = page.next;
  }
}

async function fetchProjectPage(
  projectRoot: string,
  team: string,
  options: VercelProjectOperationOptions & { search?: string; until?: number },
): Promise<VercelProjectPage> {
  const result = await captureVercel(
    ["api", projectsApiPath(options.search, options.until), "--scope", team, "--raw"],
    {
      cwd: projectRoot,
      signal: options.signal,
      timeoutMs: PROJECT_LIST_TIMEOUT_MS,
    },
  );
  if (!result.ok) {
    if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
    throw new Error(`Could not list Vercel projects in ${team}. ${result.failure.message}`);
  }
  return parseProjectPage(result.stdout);
}

/** Lists the first 20 Vercel projects in one account scope. */
export async function listProjects(
  projectRoot: string,
  team: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelProjectListEntry[]> {
  return (await fetchProjectPage(projectRoot, team, options)).projects;
}

/** Searches every Vercel project page in one account scope. */
export async function searchProjects(
  projectRoot: string,
  team: string,
  query: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelProjectListEntry[]> {
  const search = query.trim();
  if (search.length === 0) throw new Error("Project search query cannot be empty.");

  const projects = new Map<string, VercelProjectListEntry>();
  const cursors = new Set<number>();
  let until: number | undefined;
  while (true) {
    const pageOptions: VercelProjectOperationOptions & { search: string; until?: number } = {
      ...options,
      search,
    };
    if (until !== undefined) pageOptions.until = until;
    const page = await fetchProjectPage(projectRoot, team, pageOptions);
    for (const project of page.projects) projects.set(project.id, project);
    if (page.next === undefined) return [...projects.values()];
    if (cursors.has(page.next)) {
      throw new Error(
        `Vercel returned a repeated pagination cursor for project search in ${team}.`,
      );
    }
    cursors.add(page.next);
    until = page.next;
  }
}
