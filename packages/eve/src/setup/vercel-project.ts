import { createPromptCommandOutput, whimsyFor } from "#setup/cli/index.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { captureVercel, runVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import pc from "picocolors";
import { z } from "zod";

import {
  assertNoLegacyProjectLinkDirectory,
  readProjectLink,
  type ProjectResolution,
} from "./project-resolution.js";
import type { Prompter } from "./prompter.js";
import type { ResolvedVercelProjectSpec, VercelProjectIdentity } from "./state.js";
import { withSpinner } from "./with-spinner.js";
import {
  isForbiddenApiFailure,
  isNotFoundApiFailure,
  normalizeVercelApiResult,
} from "./vercel-api-failure.js";
import {
  listRecentProjects,
  listTeams,
  parseVercelJson,
  rankProjectSearchResults,
  requireVercelTeamAccess,
  searchProjects,
  type VercelProjectListEntry,
  type VercelProjectOperationOptions,
  VERCEL_PROJECT_REQUEST_TIMEOUT_MS,
} from "./vercel-project-api.js";
import {
  ensureCreatedProjectFramework,
  type CreatedProjectFrameworkOptions,
} from "./vercel-project-framework.js";

const VercelProjectReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export interface PickProjectOptions extends VercelProjectOperationOptions {
  /** Whether an empty project list may fall back to entering a name to create. */
  allowCreateWhenEmpty?: boolean;
  /**
   * Searches the team for a project with this name before the list opens and
   * suggests the best match: floated to the top, cursor on it, marked
   * "suggested". Best-effort — a failed lookup falls back to the plain list.
   */
  suggestedName?: string;
}

export interface PickTeamOptions extends VercelProjectOperationOptions {
  /** Builds the team selector heading from the current team's display name. */
  selectMessage?: (currentTeam: string) => string;
}

export interface LinkProjectOperationOptions extends CreatedProjectFrameworkOptions {}

export function unresolvedProject(): ProjectResolution {
  return { kind: "unresolved" };
}

/** Resolves the linked project id from a resolution, if any. */
export function projectIdFromResolution(project: ProjectResolution): string | undefined {
  return project.kind === "unresolved" ? undefined : project.projectId;
}

function parseProjectReference(stdout: string, description: string): VercelProjectIdentity {
  const parsed = VercelProjectReferenceSchema.safeParse(parseVercelJson(stdout, description));
  if (!parsed.success) {
    throw new Error(`Could not read Vercel project identity from ${description}.`);
  }
  return { projectId: parsed.data.id, projectName: parsed.data.name };
}

/** Resolves one project by exact name or id through the Vercel API. */
export async function resolveProjectByNameOrId(
  projectRoot: string,
  team: string,
  projectNameOrId: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelProjectIdentity | null> {
  const result = normalizeVercelApiResult(
    await captureVercel(
      ["api", `/v9/projects/${encodeURIComponent(projectNameOrId)}`, "--scope", team, "--raw"],
      {
        cwd: projectRoot,
        signal: options.signal,
        timeoutMs: VERCEL_PROJECT_REQUEST_TIMEOUT_MS,
      },
    ),
  );
  if (result.ok) {
    return parseProjectReference(result.stdout, `project ${projectNameOrId}`);
  }
  if (isNotFoundApiFailure(result.failure)) {
    return null;
  }
  if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
  throw new Error(
    `Could not resolve project "${projectNameOrId}" in ${team}. ${result.failure.message}`,
  );
}

function projectNameCollisionMessage(projectName: string, team: string): string {
  return `Vercel project "${projectName}" already exists in ${team}. Pass --project ${projectName} to link it, or choose a different project name.`;
}

export async function assertNewProjectNameAvailable(
  projectRoot: string,
  team: string,
  projectName: string,
  options: VercelProjectOperationOptions = {},
): Promise<void> {
  const existing = await resolveProjectByNameOrId(projectRoot, team, projectName, options);
  if (existing !== null) {
    throw new Error(projectNameCollisionMessage(projectName, team));
  }
}

/**
 * Throws the login action. When the underlying `vercel whoami` failure is
 * known, its diagnostic is folded into the reason: without it the agent only
 * ever hears "log in", even when the real fault is a missing CLI or a transient
 * API error and the user is already authenticated.
 */
export function requireVercelLogin(failure?: VercelCaptureFailure): never {
  const base = "Provisioning a Vercel project requires you to be logged in to Vercel.";
  const stderr = failure?.stderr.trim();
  const reason = failure
    ? `${base} The Vercel CLI check did not succeed: ${failure.message}${stderr ? ` ${stderr}` : ""}`
    : base;
  throw new HumanActionRequiredError({ kind: "vercel-login", command: "vercel login", reason });
}

/**
 * Bound on a read-only `vercel whoami` probe so a network hang — or a CLI that
 * tries to start an interactive flow despite stdin being closed — can never
 * wedge boot or a setup command.
 */
const WHOAMI_TIMEOUT_MS = 10_000;

/** Runs the bounded, read-only `vercel whoami` probe shared by the auth checks. */
function probeWhoami(projectRoot: string, options: VercelProjectOperationOptions) {
  return captureVercel(["whoami"], {
    cwd: projectRoot,
    signal: options.signal,
    timeoutMs: WHOAMI_TIMEOUT_MS,
  });
}

/**
 * Whether a failed `whoami` is the explicit not-authenticated diagnostic ("No
 * existing credentials found" / "not authenticated") rather than a transient
 * fault (DNS, network, API error, timeout). Only the former is a genuine
 * logged-out state; classifying any non-zero exit as logged-out would route a
 * network blip to `/vc:login`.
 */
function isLoggedOutFailure(failure: VercelCaptureFailure): boolean {
  const text = `${failure.stdout} ${failure.stderr}`.toLowerCase();
  return (
    text.includes("credentials") ||
    text.includes("not authenticated") ||
    text.includes("not logged in")
  );
}

/**
 * Throws the right outcome for a failed `vercel whoami`. ENOENT means the
 * binary isn't installed (its own action, not a login that would fail
 * identically); the explicit not-authenticated diagnostic is a login action;
 * anything else is a transient fault surfaced as a plain error, so the caller
 * reports "try again" rather than mislabeling it "log in".
 */
export function requireVercelAuth(failure: VercelCaptureFailure): never {
  if (failure.errno === "ENOENT") {
    throw new HumanActionRequiredError({
      kind: "vercel-cli-missing",
      command: "npm i -g vercel@latest",
      reason: failure.message,
    });
  }
  if (isLoggedOutFailure(failure)) {
    requireVercelLogin(failure);
  }
  const stderr = failure.stderr.trim();
  throw new Error(
    `Couldn't verify your Vercel login: ${failure.message}${stderr ? ` ${stderr}` : ""}`,
  );
}

/**
 * The Vercel auth state, read-only. `cli-missing` (ENOENT) and `unavailable` (a
 * transient network/API fault) are each kept distinct from `logged-out` so a
 * caller never tells the user to log in when the real cause is a missing CLI or
 * an unreachable network. `logged-out` is claimed only from the explicit
 * not-authenticated diagnostic.
 */
export type VercelAuthStatus = "authenticated" | "logged-out" | "cli-missing" | "unavailable";

/** Returns the user-facing reason Vercel-backed setup is unavailable. */
export function vercelAuthBlockerReason(authStatus: VercelAuthStatus): string | undefined {
  switch (authStatus) {
    case "authenticated":
      return undefined;
    case "cli-missing":
      return "Vercel CLI not found, see /vc:install";
    case "logged-out":
      return "Log in to Vercel first, see /vc:login";
    case "unavailable":
      return "Couldn't reach Vercel, check your connection";
    default: {
      const exhaustive: never = authStatus;
      return exhaustive;
    }
  }
}

export async function getVercelAuthStatus(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelAuthStatus> {
  const result = await probeWhoami(projectRoot, options);
  options.signal?.throwIfAborted();
  if (result.ok) return "authenticated";
  if (result.failure.errno === "ENOENT") return "cli-missing";
  return isLoggedOutFailure(result.failure) ? "logged-out" : "unavailable";
}

/**
 * Ensures Vercel authentication before any provisioning. `vercel whoami` exits
 * non-zero when not logged in; any other failure (a missing CLI, a transient
 * API error) is surfaced verbatim rather than mislabeled as a login problem.
 */
export async function requireAuth(
  projectRoot: string,
  prompter?: Prompter,
  options: VercelProjectOperationOptions = {},
): Promise<void> {
  const check = async () => {
    const result = await probeWhoami(projectRoot, options);
    options.signal?.throwIfAborted();
    if (!result.ok) {
      requireVercelAuth(result.failure);
    }
  };
  if (prompter === undefined) {
    await check();
    return;
  }
  await withSpinner(prompter, whimsyFor("auth"), check);
}

/**
 * Non-throwing auth probe: whether the Vercel CLI has a logged-in user. Used
 * where authentication changes a decision (e.g. adopting an existing link)
 * rather than being a precondition to enforce.
 */
export async function isVercelAuthenticated(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<boolean> {
  return (await getVercelAuthStatus(projectRoot, options)) === "authenticated";
}

/** The current scope identifier (team slug or personal username) from `vercel whoami`. */
async function whoamiScope(
  projectRoot: string,
  options: VercelProjectOperationOptions,
): Promise<string> {
  const result = await probeWhoami(projectRoot, options);
  options.signal?.throwIfAborted();
  if (!result.ok) {
    requireVercelAuth(result.failure);
  }
  return result.stdout.trim();
}

/**
 * Resolves a passed team slug, or the current scope when unset, to a concrete
 * slug so every provisioning command can pass an explicit `--scope`.
 */
export async function resolveTeam(
  projectRoot: string,
  team: string | undefined,
  options: VercelProjectOperationOptions = {},
): Promise<string> {
  if (team !== undefined) return team;
  const teams = await listTeams(projectRoot, options);
  return teams.find((entry) => entry.current)?.slug ?? (await whoamiScope(projectRoot, options));
}

/**
 * Validates a passed team slug against the account's teams, failing fast.
 *
 * When the slug is provided and the account's teams are listable, an unknown
 * slug throws so the run stops before any project mutation. When Vercel returns
 * an empty list, validation does not block and the later scoped command
 * surfaces any real scope error itself.
 *
 * `prompter` is accepted so callers can pass it uniformly across the team
 * resolution helpers; it is unused now that an invalid slug throws.
 */
export async function validateTeam(
  prompter: Prompter,
  projectRoot: string,
  team: string | undefined,
  options: VercelProjectOperationOptions = {},
): Promise<void> {
  void prompter;
  if (team === undefined) return;
  const teams = await listTeams(projectRoot, options);
  if (teams.length > 0 && !teams.some((entry) => entry.slug === team)) {
    throw new Error(
      `Team "${team}" was not found in \`vercel teams ls\`. Pass a valid team slug or omit --team.`,
    );
  }
}

/**
 * Picks the Vercel team (scope). A passed slug is validated and resolved; with
 * zero or one team the current scope is used without prompting; otherwise the
 * user filters and chooses from the list with a single-selection picker.
 */
export async function pickTeam(
  prompter: Prompter,
  projectRoot: string,
  presetTeam: string | undefined,
  options: PickTeamOptions = {},
): Promise<string> {
  if (presetTeam !== undefined) {
    await validateTeam(prompter, projectRoot, presetTeam, options);
    return resolveTeam(projectRoot, presetTeam, options);
  }
  const teams = await withSpinner(prompter, whimsyFor("teams"), () =>
    listTeams(projectRoot, options),
  );
  if (teams.length <= 1) {
    return teams.find((team) => team.current)?.slug ?? (await whoamiScope(projectRoot, options));
  }
  const currentTeam = teams.find((team) => team.current);
  return prompter.select({
    message:
      options.selectMessage?.(currentTeam?.name ?? (await whoamiScope(projectRoot, options))) ??
      "Select your team",
    search: true,
    placeholder: "type to search teams",
    options: teams.map((team) => ({
      value: team.slug,
      label: team.current ? `${team.name} (current)` : team.name,
    })),
    initialValue: currentTeam?.slug,
  });
}

const SEARCH_PROJECT_PREFIX = "\0search-project:";
const SEARCH_MORE_PROJECTS_PREFIX = "\0search-more-projects:";

type ProjectSearchResults = Awaited<ReturnType<typeof searchProjects>>;

interface ProjectSearchContinuation {
  readonly query: string;
  readonly next: number;
}

function searchMoreProjectsValue(continuation: ProjectSearchContinuation): string {
  return `${SEARCH_MORE_PROJECTS_PREFIX}${continuation.next}:${continuation.query}`;
}

function prioritizeSearchResults(
  existing: readonly VercelProjectListEntry[],
  found: readonly VercelProjectListEntry[],
): VercelProjectListEntry[] {
  const projects = new Map(found.map((project) => [project.id, project]));
  for (const project of existing) {
    if (!projects.has(project.id)) projects.set(project.id, project);
  }
  return [...projects.values()];
}

async function findProjectSearchResults(
  projectRoot: string,
  team: string,
  query: string,
  options: VercelProjectOperationOptions,
  next?: number,
): Promise<ProjectSearchResults> {
  const search = query.trim();
  if (search.length === 0) throw new Error("Project search query cannot be empty.");

  if (next === undefined) {
    const exact = await resolveProjectByNameOrId(projectRoot, team, search, options);
    if (exact !== null) return { projects: [{ id: exact.projectId, name: exact.projectName }] };
  }

  return await searchProjects(projectRoot, team, search, { ...options, next });
}

/**
 * Finds the project to suggest for `name`: an exact hit in the already-listed
 * recents, or the team's best name-search match. Best-effort — failures mean
 * "no suggestion", never an aborted picker.
 */
async function findSuggestedProject(
  projectRoot: string,
  team: string,
  name: string,
  recents: readonly VercelProjectListEntry[],
  options: VercelProjectOperationOptions,
): Promise<VercelProjectListEntry | undefined> {
  const inRecents = recents.find((project) => project.name === name);
  if (inRecents !== undefined) return inRecents;
  try {
    const found = await findProjectSearchResults(projectRoot, team, name, options);
    return rankProjectSearchResults(found.projects, name)[0];
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
}

/** Picks an existing project under a team, or a name to create when none exist. */
export async function pickProject(
  prompter: Prompter,
  projectRoot: string,
  team: string,
  options: PickProjectOptions = {},
): Promise<ResolvedVercelProjectSpec> {
  const suggestedName = options.suggestedName?.trim();
  const listed = await withSpinner(prompter, whimsyFor("projects", team), async () => {
    const recents = await listRecentProjects(projectRoot, team, options);
    const suggested =
      suggestedName === undefined || suggestedName.length === 0
        ? undefined
        : await findSuggestedProject(projectRoot, team, suggestedName, recents, options);
    return { recents, suggested };
  });
  const suggestedId = listed.suggested?.id;
  let projects =
    listed.suggested === undefined
      ? listed.recents
      : prioritizeSearchResults(listed.recents, [listed.suggested]);
  let searchResults: readonly VercelProjectListEntry[] = [];
  let searchContinuation: ProjectSearchContinuation | undefined;
  const projectOptions = () => {
    const result = projects.map((project) => {
      const option: { value: string; label: string; hint?: string } = {
        value: project.id,
        label: project.name,
      };
      if (project.id === suggestedId) option.hint = "suggested";
      return option;
    });
    if (searchContinuation !== undefined) {
      result.push({
        value: searchMoreProjectsValue(searchContinuation),
        label: `Show more matches for '${searchContinuation.query}'`,
      });
    }
    return result;
  };
  const applySearchResults = (
    query: string,
    found: ProjectSearchResults,
    append: boolean,
  ): void => {
    const existing = append ? searchResults : [];
    searchResults = rankProjectSearchResults([...existing, ...found.projects], query);
    projects = prioritizeSearchResults(projects, searchResults);
    searchContinuation =
      found.next === undefined ? undefined : { query: query.trim(), next: found.next };
  };
  if (projects.length === 0) {
    if (options.allowCreateWhenEmpty === false) {
      throw new Error(
        `No existing Vercel projects found in ${team}. Create one in Vercel, then try again.`,
      );
    }
    const project = await prompter.text({
      message: `No projects found in ${team}. Enter a project name to create`,
      validate: (value) =>
        value.trim().length === 0 ? "Project name cannot be empty." : undefined,
    });
    return { kind: "new", project, team };
  }

  while (true) {
    const selected = await prompter.select({
      message: "Project to link",
      search: true,
      placeholder: "type to filter projects",
      searchAction: {
        label: (query) => `Search for '${query}'`,
        value: (query) => `${SEARCH_PROJECT_PREFIX}${query}`,
        load: async (query) => {
          const found = await findProjectSearchResults(projectRoot, team, query, {
            signal: options.signal,
          });
          applySearchResults(query, found, false);
          return projectOptions();
        },
      },
      options: projectOptions(),
      initialValue: suggestedId ?? projects[0]?.id,
    });
    const continuation = searchContinuation;
    if (continuation !== undefined && selected === searchMoreProjectsValue(continuation)) {
      const found = await withSpinner(
        prompter,
        `Searching ${team} for "${continuation.query}"...`,
        () =>
          findProjectSearchResults(
            projectRoot,
            team,
            continuation.query,
            { signal: options.signal },
            continuation.next,
          ),
      );
      applySearchResults(continuation.query, found, true);
      continue;
    }
    const query = selected.startsWith(SEARCH_PROJECT_PREFIX)
      ? selected.slice(SEARCH_PROJECT_PREFIX.length)
      : undefined;
    if (query === undefined) {
      const project = projects.find((candidate) => candidate.id === selected);
      if (project === undefined) throw new Error("Selected Vercel project is not available.");
      return {
        kind: "existing",
        project: { projectId: project.id, projectName: project.name },
        team,
      };
    }

    const found = await withSpinner(prompter, `Searching ${team} for "${query}"...`, () =>
      findProjectSearchResults(projectRoot, team, query, { signal: options.signal }),
    );
    applySearchResults(query, found, false);
    if (found.projects.length === 0 && found.next === undefined) {
      prompter.note(`No projects matched "${query}" in ${team}.`);
      continue;
    }
  }
}

/** Returns a project name for a new Vercel project, prompting when the default exists. */
export async function pickNewProjectName(
  prompter: Prompter,
  projectRoot: string,
  team: string,
  defaultProjectName: string,
  options: VercelProjectOperationOptions = {},
): Promise<string> {
  let existing = await withSpinner(prompter, whimsyFor("project-name", team), () =>
    resolveProjectByNameOrId(projectRoot, team, defaultProjectName.trim(), options),
  );
  let projectName = defaultProjectName.trim();
  while (existing !== null) {
    projectName = (
      await prompter.text({
        message: "New project name",
        defaultValue: `${projectName}-2`,
        // A notice, not a persistent log line: the collision matters only
        // while the question is open, so it vanishes once a free name lands.
        // Yellow segments around blue names: nesting a color inside pc.yellow
        // closes with default-foreground and would strip the yellow from the
        // rest of the sentence, so the names are styled as their own spans.
        notices: [
          {
            tone: "warning",
            text: `${pc.yellow("Project named")} '${pc.blue(projectName)}' ${pc.yellow(
              "already exists in",
            )} '${pc.blue(team)}'`,
          },
        ],
        validate: (value) => {
          const name = value.trim();
          if (name.length === 0) return "Project name cannot be empty.";
          return undefined;
        },
      })
    ).trim();
    existing = await resolveProjectByNameOrId(projectRoot, team, projectName, options);
  }
  return projectName;
}

/**
 * Ensures the concrete project exists (creating it for a `new` plan) and links
 * this directory to it. Acts on a fully-resolved spec — never prompts for a
 * team or project. A newly created project keeps a detected host framework
 * when the matching eve integration import is present; otherwise missing,
 * unsupported, or rejected framework detections are switched back to eve.
 * Returns the linked project, or undefined if `vercel link` did not complete.
 */
export async function linkProject(
  prompter: Prompter,
  projectRoot: string,
  spec: ResolvedVercelProjectSpec,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  options: LinkProjectOperationOptions = {},
): Promise<VercelProjectIdentity | undefined> {
  await assertNoLegacyProjectLinkDirectory(projectRoot);
  const scope = ["--scope", spec.team];
  if (spec.kind === "new") {
    const linked = await withSpinner(
      prompter,
      `Creating Vercel project "${spec.project}" in ${spec.team}...`,
      async () => {
        await assertNewProjectNameAvailable(projectRoot, spec.team, spec.project, options);
        return runVercel(["link", "--project", spec.project, ...scope, "--yes"], {
          cwd: projectRoot,
          onOutput,
          nonInteractive: true,
          signal: options.signal,
        });
      },
    );
    if (!linked) return undefined;
    const link = await readProjectLink(projectRoot);
    if (link === undefined) return undefined;
    await ensureCreatedProjectFramework(
      prompter,
      projectRoot,
      spec.team,
      link.projectId,
      onOutput,
      options,
    );
    return { projectId: link.projectId, projectName: link.projectName ?? spec.project };
  }

  const project = spec.project;
  const linked = await withSpinner(
    prompter,
    `Linking this directory to Vercel project "${project.projectName}"...`,
    () =>
      runVercel(["link", "--project", project.projectId, ...scope, "--yes"], {
        cwd: projectRoot,
        onOutput,
        // The plan already names the team and project, so the link needs no
        // input. eve strips the coding-agent env markers (so the CLI does not
        // mis-react to the agent driving it), which also stops the CLI from
        // auto-enabling its agent non-interactive default — left with an
        // inherited TTY it would prompt (e.g. the MCP/plugin setup question)
        // and read stdin, wedging the dev TUI. Force non-interactive: it both
        // passes `--non-interactive` and closes the child's stdin.
        nonInteractive: true,
        signal: options.signal,
      }),
  );
  return linked ? project : undefined;
}
