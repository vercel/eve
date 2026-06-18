import { createPromptCommandOutput, whimsyFor } from "#setup/cli/index.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { captureVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import pc from "picocolors";
import { z } from "zod";

import { writeProjectLink, type ProjectResolution } from "./project-resolution.js";
import type { Prompter } from "./prompter.js";
import type { ResolvedVercelProjectSpec } from "./state.js";
import {
  isConflictApiFailure,
  isForbiddenApiFailure,
  isNotFoundApiFailure,
  listProjects,
  listTeams,
  parseVercelJson,
  requireVercelTeamAccess,
  searchProjects,
  type VercelProjectOperationOptions,
} from "./vercel-project-api.js";
import { pickExistingVercelProject } from "./vercel-project-picker.js";

export {
  listProjects,
  listTeams,
  requireVercelTeamAccess,
  searchProjects,
  type VercelProjectOperationOptions,
} from "./vercel-project-api.js";

const VercelProjectReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accountId: z.string().min(1),
});

type VercelProjectReference = z.infer<typeof VercelProjectReferenceSchema>;

export interface PickProjectOptions extends VercelProjectOperationOptions {
  /** Whether an empty project list may fall back to entering a name to create. */
  allowCreateWhenEmpty?: boolean;
  /** Question shown when choosing an existing project. */
  message?: string;
}

export interface PickTeamOptions extends VercelProjectOperationOptions {
  /** Keep the team choice visible even when only one team is available. */
  promptWhenSingle?: boolean;
  /** Question shown when choosing a team. */
  message?: string;
  /**
   * Pre-position the cursor on this team slug instead of the CLI's current
   * team. Used when a flow steps back to the picker so the prior choice stays
   * highlighted.
   */
  initialValue?: string;
}

export function unresolvedProject(): ProjectResolution {
  return { kind: "unresolved" };
}

/**
 * Runs a network reach behind a section-like spinner so the user sees the CLI
 * is working, not hung. The spinner clears whether the work resolves or throws,
 * and degrades to nothing when the prompter has no spinner (headless/test).
 */
export async function withNetworkSpinner<T>(
  prompter: Prompter,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  const spinner = prompter.log.spinner?.(message);
  try {
    return await task();
  } finally {
    spinner?.stop();
  }
}

/** Resolves the linked project id from a resolution, if any. */
export function projectIdFromResolution(project: ProjectResolution): string | undefined {
  return project.kind === "unresolved" ? undefined : project.projectId;
}

function parseProjectReference(stdout: string, description: string): VercelProjectReference {
  const parsed = VercelProjectReferenceSchema.safeParse(parseVercelJson(stdout, description));
  if (!parsed.success) {
    throw new Error(`Could not read Vercel project identity from ${description}.`);
  }
  return parsed.data;
}

/** Resolves one project by exact name or id through the Vercel API. */
export async function resolveProjectByNameOrId(
  projectRoot: string,
  team: string,
  projectNameOrId: string,
  options: VercelProjectOperationOptions = {},
): Promise<VercelProjectReference | null> {
  const result = await captureVercel(
    ["api", `/v9/projects/${encodeURIComponent(projectNameOrId)}`, "--scope", team, "--raw"],
    { cwd: projectRoot, signal: options.signal },
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

async function createProject(
  projectRoot: string,
  team: string,
  projectName: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  options: VercelProjectOperationOptions,
): Promise<VercelProjectReference> {
  const result = await captureVercel(
    [
      "api",
      "/v10/projects",
      "--scope",
      team,
      "--method",
      "POST",
      "--raw-field",
      `name=${projectName}`,
      "--raw",
    ],
    { cwd: projectRoot, onOutput, signal: options.signal },
  );
  if (result.ok) {
    return parseProjectReference(result.stdout, `created project ${projectName}`);
  }
  if (isConflictApiFailure(result.failure)) {
    throw new Error(projectNameCollisionMessage(projectName, team));
  }
  if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
  throw new Error(
    `Could not create Vercel project "${projectName}" in ${team}. ${result.failure.message}`,
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
  await withNetworkSpinner(prompter, whimsyFor("auth"), check);
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
  const teams = await withNetworkSpinner(prompter, whimsyFor("teams"), () =>
    listTeams(projectRoot, options),
  );
  if (teams.length <= 1 && options.promptWhenSingle !== true) {
    return teams.find((team) => team.current)?.slug ?? (await whoamiScope(projectRoot, options));
  }
  if (teams.length === 0) {
    return whoamiScope(projectRoot, options);
  }
  return prompter.select({
    message: options.message ?? "Select your team",
    search: true,
    placeholder: "type to search teams",
    options: teams.map((team) => ({
      value: team.slug,
      label: team.current ? `${team.name} (current)` : team.name,
    })),
    initialValue: options.initialValue ?? teams.find((team) => team.current)?.slug,
  });
}

/**
 * A picked Vercel project. `exists` distinguishes a project the user selected
 * from the existing list (link it) from a name they typed because none exist
 * yet (create it), so the caller can build the right `new` vs `existing` plan.
 */
export interface ArgsPickedProject {
  /** Project slug: an existing project's name, or a name to create. */
  project: string;
  /** True for a selected existing project; false for a typed-in name to create. */
  exists: boolean;
}

/** Picks an existing project under a team, or a name to create when none exist. */
export async function pickProject(
  prompter: Prompter,
  projectRoot: string,
  team: string,
  options: PickProjectOptions = {},
): Promise<ArgsPickedProject> {
  const projects = await withNetworkSpinner(prompter, whimsyFor("projects", team), () =>
    listProjects(projectRoot, team, options),
  );
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
    return { project, exists: false };
  }
  const project = await pickExistingVercelProject({
    prompter,
    team,
    message: options.message ?? "Project to link",
    projects,
    search: (query) =>
      withNetworkSpinner(prompter, `Searching ${team} for "${query}"...`, () =>
        searchProjects(projectRoot, team, query, { signal: options.signal }),
      ),
  });
  return { project, exists: true };
}

/** Returns a project name for a new Vercel project, prompting when the default exists. */
export async function pickNewProjectName(
  prompter: Prompter,
  projectRoot: string,
  team: string,
  defaultProjectName: string,
  options: VercelProjectOperationOptions = {},
): Promise<string> {
  let existing = await withNetworkSpinner(prompter, whimsyFor("project-name", team), () =>
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
 * this directory to it. Pure executor: it acts on a fully-resolved spec and
 * never prompts for a team or project. Returns after the link metadata is written.
 */
export async function linkProject(
  prompter: Prompter,
  projectRoot: string,
  spec: ResolvedVercelProjectSpec,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  options: VercelProjectOperationOptions = {},
): Promise<boolean> {
  let project: VercelProjectReference;
  if (spec.kind === "new") {
    project = await withNetworkSpinner(
      prompter,
      `Creating Vercel project "${spec.project}" in ${spec.team}...`,
      async () => {
        await assertNewProjectNameAvailable(projectRoot, spec.team, spec.project, options);
        return createProject(projectRoot, spec.team, spec.project, onOutput, options);
      },
    );
  } else {
    const existing = await resolveProjectByNameOrId(projectRoot, spec.team, spec.project, options);
    if (existing === null) {
      throw new Error(`Vercel project "${spec.project}" was not found in ${spec.team}.`);
    }
    project = existing;
  }
  await withNetworkSpinner(
    prompter,
    `Linking this directory to Vercel project "${project.name}"...`,
    () =>
      writeProjectLink({
        projectRoot,
        link: {
          projectId: project.id,
          orgId: project.accountId,
          projectName: project.name,
        },
        signal: options.signal,
      }),
  );
  return true;
}
