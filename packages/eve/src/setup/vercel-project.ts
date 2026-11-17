import { createPromptCommandOutput, whimsyFor } from "#setup/cli/index.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { captureVercel, runVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import pc from "#compiled/picocolors/index.js";
import { z } from "#compiled/zod/index.js";

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
  checkTeamRequirement,
  checkTeamRequirements,
  type VercelTeamRequirement,
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
import { configureTraceSampling } from "./vercel-trace-sampling.js";

const VercelProjectReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

interface PickProjectOptions extends VercelProjectOperationOptions {
  allowCreateWhenEmpty?: boolean;
  suggestedName?: string;
}

interface PickTeamOptions extends VercelProjectOperationOptions {
  teamRequirement?: VercelTeamRequirement;
  selectMessage?: (currentTeam: string) => string;
}

export interface LinkProjectOperationOptions extends CreatedProjectFrameworkOptions {
  traceSampling?: boolean;
}

export function unresolvedProject(): ProjectResolution {
  return { kind: "unresolved" };
}

function parseProjectReference(stdout: string, description: string): VercelProjectIdentity {
  const parsed = VercelProjectReferenceSchema.safeParse(parseVercelJson(stdout, description));
  if (!parsed.success) {
    throw new Error(`Could not read Vercel project identity from ${description}.`);
  }
  return { projectId: parsed.data.id, projectName: parsed.data.name };
}

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

function requireVercelLogin(failure?: VercelCaptureFailure): never {
  const base =
    "The Vercel CLI is not logged in to an account with access to this project. Run `vercel login`.";
  const stderr = failure?.stderr.trim();
  const reason = failure
    ? `${base} The Vercel CLI check did not succeed: ${failure.message}${stderr ? ` ${stderr}` : ""}`
    : base;
  throw new HumanActionRequiredError({ kind: "vercel-login", command: "vercel login", reason });
}

const WHOAMI_TIMEOUT_MS = 10_000;

const WhoamiJsonSchema = z.object({
  loggedIn: z.boolean().optional(),
  reason: z.string().optional(),
  username: z.string().optional(),
  app: z.object({ id: z.string() }).optional(),
});

const LOGIN_REQUIRED_REASONS = new Set([
  "login_required",
  "not_authorized",
  "scope_not_accessible",
]);

function parseWhoamiJson(stdout: string): z.infer<typeof WhoamiJsonSchema> | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  try {
    const parsed = WhoamiJsonSchema.safeParse(JSON.parse(stdout.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

type WhoamiProbe =
  | { status: "authenticated"; stdout: string }
  | {
      status: Exclude<VercelAuthStatus, "authenticated">;
      failure: VercelCaptureFailure;
    };

async function probeWhoami(
  projectRoot: string,
  options: VercelProjectOperationOptions,
): Promise<WhoamiProbe> {
  const link = await readProjectLink(projectRoot);
  const args = [
    "whoami",
    "--format",
    "json",
    ...(link?.orgId.startsWith("team_") ? ["--scope", link.orgId] : []),
  ];
  const result = await captureVercel(args, {
    cwd: projectRoot,
    signal: options.signal,
    timeoutMs: WHOAMI_TIMEOUT_MS,
  });
  options.signal?.throwIfAborted();
  if (result.ok) return { status: "authenticated", stdout: result.stdout };
  return { status: classifyWhoamiFailure(result.failure), failure: result.failure };
}

function classifyWhoamiFailure(
  failure: VercelCaptureFailure,
): Exclude<VercelAuthStatus, "authenticated"> {
  if (failure.errno === "ENOENT") return "cli-missing";
  const json = parseWhoamiJson(failure.stdout);
  if (
    json?.loggedIn === false ||
    (json?.reason !== undefined && LOGIN_REQUIRED_REASONS.has(json.reason))
  ) {
    return "logged-out";
  }
  return isLoggedOutDiagnostic(failure) ? "logged-out" : "unavailable";
}

function isLoggedOutDiagnostic(failure: VercelCaptureFailure): boolean {
  const text = `${failure.stdout} ${failure.stderr}`.toLowerCase();
  return (
    text.includes("credentials") ||
    text.includes("not authenticated") ||
    text.includes("not authorized") ||
    text.includes("not logged in") ||
    /token\b.*\bis not valid/u.test(text) ||
    text.includes("scope-not-accessible") ||
    text.includes("do not have access to the specified account")
  );
}

function requireVercelAuth(probe: Exclude<WhoamiProbe, { status: "authenticated" }>): never {
  const { failure } = probe;
  if (probe.status === "cli-missing") {
    throw new HumanActionRequiredError({
      kind: "vercel-cli-missing",
      command: "npm i -g vercel@latest",
      reason: failure.message,
    });
  }
  if (probe.status === "logged-out") requireVercelLogin(failure);
  const stderr = failure.stderr.trim();
  throw new Error(
    `Couldn't verify your Vercel login: ${failure.message}${stderr ? ` ${stderr}` : ""}`,
  );
}

export type VercelAuthStatus = "authenticated" | "logged-out" | "cli-missing" | "unavailable";

export async function getVercelAuthStatus(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelAuthStatus> {
  return (await probeWhoami(projectRoot, options)).status;
}

export async function requireAuth(
  projectRoot: string,
  prompter?: Prompter,
  options: VercelProjectOperationOptions = {},
): Promise<void> {
  const check = async () => {
    const probe = await probeWhoami(projectRoot, options);
    if (probe.status !== "authenticated") requireVercelAuth(probe);
  };
  if (prompter === undefined) {
    await check();
    return;
  }
  await withSpinner(prompter, whimsyFor("auth"), check);
}

export async function isVercelAuthenticated(
  projectRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<boolean> {
  return (await getVercelAuthStatus(projectRoot, options)) === "authenticated";
}

async function whoamiScope(
  projectRoot: string,
  options: VercelProjectOperationOptions,
): Promise<string> {
  const probe = await probeWhoami(projectRoot, options);
  if (probe.status !== "authenticated") requireVercelAuth(probe);
  const json = parseWhoamiJson(probe.stdout);
  return json?.username ?? json?.app?.id ?? probe.stdout.trim();
}

export async function resolveTeam(
  projectRoot: string,
  team: string | undefined,
  options: VercelProjectOperationOptions = {},
): Promise<string> {
  if (team !== undefined) return team;
  const teams = await listTeams(projectRoot, options);
  return teams.find((entry) => entry.current)?.slug ?? (await whoamiScope(projectRoot, options));
}

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

export async function pickTeam(
  prompter: Prompter,
  projectRoot: string,
  presetTeam: string | undefined,
  options: PickTeamOptions = {},
): Promise<string> {
  if (presetTeam !== undefined) {
    await validateTeam(prompter, projectRoot, presetTeam, options);
    const team = await resolveTeam(projectRoot, presetTeam, options);
    if (options.teamRequirement) {
      const issue = await checkTeamRequirement(projectRoot, team, options.teamRequirement, options);
      if (issue) throw new Error(`Cannot use Vercel team "${team}". ${issue}`);
    }
    return team;
  }
  const teams = await withSpinner(prompter, whimsyFor("teams"), () =>
    listTeams(projectRoot, options),
  );
  if (options.teamRequirement) {
    const requirement = options.teamRequirement;
    const issues = await withSpinner(prompter, "Checking team permissions…", () =>
      checkTeamRequirements(projectRoot, teams, requirement, options),
    );
    const choices = teams
      .map((team) => {
        const issue = issues.get(team.slug);
        return {
          value: team.slug,
          label: team.current ? `${team.name} (current)` : team.name,
          disabled: issue !== undefined,
          disabledReason:
            issue === undefined
              ? undefined
              : issue === requirement.disabledReason
                ? "needs permission"
                : "couldn't verify",
        };
      })
      .sort((a, b) => Number(a.disabled) - Number(b.disabled));
    const helpText = [
      ...(choices.some((choice) => choice.disabledReason === "needs permission")
        ? [
            "For teams that need permission, ask a team owner to run setup,\nor choose another team.",
          ]
        : []),
      ...(choices.some((choice) => choice.disabledReason === "couldn't verify")
        ? ["Couldn't verify access? Retry, or run `vercel login` and try again."]
        : []),
    ].join("\n");
    const enabled = choices.filter((choice) => !choice.disabled);
    if (enabled.length === 0) {
      if (choices.length)
        prompter.note(
          choices.map((choice) => `${choice.label}: ${choice.disabledReason}`).join("\n"),
        );
      throw new Error(
        `No Vercel teams are available for this setup. ${requirement.disabledReason} If permissions could not be verified, run \`vercel login\` and retry.`,
      );
    }
    const current = teams.find((team) => team.current);
    const selected = await prompter.select({
      message: options.selectMessage?.(current?.name ?? "your current team") ?? "Select your team",
      search: true,
      placeholder: "type to search teams",
      options: choices,
      helpText: helpText || undefined,
      initialValue:
        enabled.find((choice) => choice.value === current?.slug)?.value ?? enabled[0]!.value,
    });
    if (!enabled.some((choice) => choice.value === selected)) {
      throw new Error(`Cannot use Vercel team "${selected}". ${requirement.disabledReason}`);
    }
    return selected;
  }
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
    if (options.traceSampling !== false)
      await configureTraceSampling(link, prompter, options.signal);
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
        nonInteractive: true,
        signal: options.signal,
      }),
  );
  return linked ? project : undefined;
}
