import { join, resolve } from "node:path";

import { byokProviderEnvVar } from "#setup/scaffold/index.js";
import { whimsyFor } from "#setup/cli/index.js";

import { select, text, type Asker } from "../ask.js";
import { pathExists } from "../path-exists.js";
import {
  detectProjectResolution,
  isProjectResolved,
  mergeProjectResolution,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import type {
  ArgsHeadlessAiGateway,
  ArgsHeadlessProject,
  ProvisioningMode,
  ResolvedAiGateway,
  ResolvedVercelProject,
  SetupState,
  WiringMode,
} from "../state.js";
import type { SetupBox } from "../step.js";
import {
  assertNewProjectNameAvailable,
  isVercelAuthenticated,
  pickNewProjectName,
  pickProject,
  pickTeam,
  requireAuth,
  resolveTeam,
  validateTeam,
} from "../vercel-project.js";
import { withSpinner } from "../with-spinner.js";

/** Injected for tests; defaults to the real Vercel project and fs helpers. */
export interface ResolveProvisioningDeps {
  requireAuth: typeof requireAuth;
  isVercelAuthenticated: typeof isVercelAuthenticated;
  detectProjectResolution: typeof detectProjectResolution;
  pathExists: typeof pathExists;
  validateTeam: typeof validateTeam;
  resolveTeam: typeof resolveTeam;
  pickTeam: typeof pickTeam;
  pickProject: typeof pickProject;
  pickNewProjectName: typeof pickNewProjectName;
  assertNewProjectNameAvailable: typeof assertNewProjectNameAvailable;
}

export interface ResolveProvisioningOptions {
  /** Resolves the provisioning-tree questions; the composed stack decides how. */
  asker: Asker;
  /**
   * Still drives the Vercel reads that validate a decision (team/project
   * pickers, auth, name availability) and carries the spinner/progress log. The
   * deploy-tree questions themselves now travel the asker.
   */
  prompter: Prompter;
  /** Parent directory the project folder is created inside. Defaults to cwd. */
  targetDirectory?: string;
  /** Headless flags vs interactive prompts. The args are read only when headless. */
  mode: ProvisioningMode;
  /**
   * Whether a detected on-disk link short-circuits the interview. Defaults to
   * true — an in-place setup adopts the link it finds. False skips adoption so
   * the team/project pickers always run: the re-link path's whole point is
   * choosing a different project, so re-adopting the current link would be a
   * dead end.
   */
  adoptExistingLink?: boolean;
  /**
   * Which project choices this interactive composition permits. Onboarding
   * defaults to creating or linking; an explicit link flow goes directly from
   * team selection to the existing-project picker.
   */
  projectSelection?: "create-or-link" | "existing-only";
  deps?: ResolveProvisioningDeps;
}

/** Both provisioning plans plus the model wiring they imply. Input and payload. */
export interface ResolvedProvisioning {
  vercelProject: ResolvedVercelProject;
  aiGateway: ResolvedAiGateway;
  modelWiring: WiringMode;
  /**
   * The detected on-disk link when the target directory is already linked to
   * a Vercel project. Adopted instead of planning a project: the link is the
   * source of truth, so the project plan stays `none` (nothing to create or
   * link) and this resolution seeds `state.project`, exactly as in-project
   * setup models the same fact.
   */
  project?: ProjectResolution;
}

/**
 * Selections from earlier in the interview that only work on Vercel: Slack
 * needs a public production URL, and Connect-backed connections authenticate
 * through a Vercel project. The single detection source for both faces of the
 * box — the interactive path resolves the where-to-run question to Vercel
 * with a note, and the headless path refuses contradicting `--skip-vercel`
 * flags.
 */
interface VercelDemands {
  slack: boolean;
  connectSlugs: string[];
}

function vercelDemands(state: Readonly<SetupState>): VercelDemands {
  return {
    slack: state.channelSelection.includes("slack"),
    connectSlugs: state.connectionSelection
      .filter((plan) => plan.entry.auth?.kind === "connect")
      .map((plan) => plan.slug),
  };
}

/** "linear authenticates …" / "linear, notion authenticate …". */
function connectClause(connectSlugs: readonly string[]): string {
  const verb = connectSlugs.length === 1 ? "authenticates" : "authenticate";
  return `${connectSlugs.join(", ")} ${verb} through Vercel Connect`;
}

/** The reasons behind a forced Vercel resolution; empty when free to choose. */
function vercelRequirements(demands: VercelDemands): string[] {
  const reasons: string[] = [];
  if (demands.slack) {
    reasons.push("Slack needs a public URL");
  }
  if (demands.connectSlugs.length > 0) {
    reasons.push(connectClause(demands.connectSlugs));
  }
  return reasons;
}

/**
 * THE PROVISIONING BOX: the last interview decision — where the agent runs —
 * made after the agent itself is described (name, model, channels,
 * connections) and before any filesystem writes or `vercel link` side
 * effects. Gather owns every decision (and the Vercel reads validating it);
 * `perform` passes the plan through untouched so `apply` can record it.
 */
export function resolveProvisioning(
  options: ResolveProvisioningOptions,
): SetupBox<SetupState, ResolvedProvisioning, ResolvedProvisioning> {
  const deps = options.deps ?? {
    requireAuth,
    isVercelAuthenticated,
    detectProjectResolution,
    pathExists,
    validateTeam,
    resolveTeam,
    pickTeam,
    pickProject,
    pickNewProjectName,
    assertNewProjectNameAvailable,
  };
  const parent = (): string => resolve(options.targetDirectory ?? process.cwd());

  /**
   * The on-disk link to adopt, when there is one. An in-place target can
   * already be linked to a Vercel project; with a logged-in CLI, the runtime
   * mints an AI Gateway token through `@vercel/oidc` from that link alone, so
   * there is nothing to ask: no where-to-run, no team, no project. Both facts
   * are required — a link without a login cannot mint a token, so that run
   * falls back to the question tree (whose Vercel branch enforces login).
   * The network reaches (production-alias read, `whoami`) run behind a
   * spinner, gated on the link file so the common unlinked case stays silent.
   */
  async function detectAdoptableLink(
    state: Readonly<SetupState>,
    signal?: AbortSignal,
  ): Promise<ProjectResolution | undefined> {
    if (state.projectPath.kind !== "resolved") return undefined;
    const path = state.projectPath.path;
    if (!(await deps.pathExists(join(path, ".vercel", "project.json")))) return undefined;
    return withSpinner(options.prompter, whimsyFor("project-detect"), async () => {
      const detected = await deps.detectProjectResolution(path, { signal });
      if (!isProjectResolved(detected)) return undefined;
      const authenticated = await deps.isVercelAuthenticated(path, { signal });
      if (!authenticated) return undefined;
      return detected;
    });
  }

  /** Maps the headless flags directly to plans, without prompting. */
  async function plansFromFlags(
    agentName: string,
    projectArgs: ArgsHeadlessProject,
    aiGatewayArgs: ArgsHeadlessAiGateway,
    signal?: AbortSignal,
  ): Promise<ResolvedProvisioning> {
    if (projectArgs.skipVercel) {
      if (aiGatewayArgs.apiKey !== undefined) {
        return {
          vercelProject: { kind: "none" },
          aiGateway: { kind: "byok", apiGatewayKey: aiGatewayArgs.apiKey },
          modelWiring: "gateway",
        };
      }
      return { vercelProject: { kind: "none" }, aiGateway: { kind: "byop" }, modelWiring: "self" };
    }
    if (projectArgs.team === undefined || projectArgs.team.length === 0) {
      throw new Error(
        "Headless Vercel provisioning requires --team <slug> or --scope <slug> so the current CLI scope is not applied silently.",
      );
    }
    await deps.requireAuth(parent(), undefined, { signal });
    await deps.validateTeam(options.prompter, parent(), projectArgs.team, { signal });
    const team = await deps.resolveTeam(parent(), projectArgs.team, { signal });
    const aiGateway: ResolvedAiGateway =
      aiGatewayArgs.apiKey !== undefined
        ? { kind: "byok", apiGatewayKey: aiGatewayArgs.apiKey }
        : { kind: "inherit" };
    const vercelProject: ResolvedVercelProject =
      projectArgs.project !== undefined
        ? { kind: "existing", project: projectArgs.project, team }
        : { kind: "new", project: agentName, team };
    if (vercelProject.kind === "new") {
      await deps.assertNewProjectNameAvailable(parent(), team, vercelProject.project, { signal });
    }
    return { vercelProject, aiGateway, modelWiring: "gateway" };
  }

  /** The "Where should your agent run?" gate and its branches. */
  async function promptPlans(
    state: Readonly<SetupState>,
    signal?: AbortSignal,
  ): Promise<ResolvedProvisioning> {
    const prompter = options.prompter;
    const agentName = state.agentName;
    // A directory that is already linked answers every provisioning question
    // at once: the project exists and the AI Gateway authenticates through
    // the Vercel login, so the whole tree collapses into a note.
    const adopted =
      options.adoptExistingLink === false ? undefined : await detectAdoptableLink(state, signal);
    if (adopted !== undefined) {
      prompter.log.info(
        "This directory is already linked to a Vercel project, so your agent will run there — " +
          "the AI Gateway authenticates through your Vercel login.",
      );
      return {
        vercelProject: { kind: "none" },
        aiGateway: { kind: "inherit" },
        modelWiring: "gateway",
        project: adopted,
      };
    }
    // Earlier selections can leave only one honest answer; then the question
    // is replaced by a note saying why. Otherwise it is asked, and a headless
    // run with no flag cannot guess it, so it is required and refuses the run
    // with InteractionRequired.
    const requirements = vercelRequirements(vercelDemands(state));
    let deployVercel = true;
    if (requirements.length > 0) {
      prompter.log.info(`${requirements.join(" and ")}, so your agent will run on Vercel.`);
    } else {
      deployVercel = await options.asker.ask(
        select<boolean>({
          key: "deploy",
          message: "Where should your agent run?",
          options: [
            {
              id: "vercel",
              value: true,
              label: "On Vercel",
              hint: "AI Gateway, Durable Workflow, Sandbox, and more",
            },
            {
              id: "local",
              value: false,
              label: "Locally for now",
              hint: "run with eve dev, deploy any time later",
            },
          ],
          recommended: true,
          required: true,
        }),
      );
    }

    if (deployVercel) {
      await deps.requireAuth(parent(), prompter, { signal });
      const team = await deps.pickTeam(prompter, parent(), undefined, { signal });
      const projectOptions = [
        {
          value: "new" as const,
          label: "Create a new project",
          hint: `Named ${agentName}`,
        },
        { value: "link" as const, label: "Link an existing project" },
      ];
      const editableChoice =
        options.projectSelection !== "existing-only" && options.prompter.selectEditable
          ? await options.prompter.selectEditable<"new" | "link">({
              message: "Vercel project",
              options: projectOptions,
              initialValue: "new",
              editable: {
                value: "new",
                defaultValue: agentName,
                formatHint: (value) => `Named ${value}`,
                validate: (value) =>
                  value.trim().length === 0 ? "Project name cannot be empty." : undefined,
              },
            })
          : undefined;
      const choice =
        options.projectSelection === "existing-only"
          ? "link"
          : (editableChoice?.value ??
            (await options.asker.ask(
              select<"new" | "link">({
                key: "vercel-project",
                message: "Vercel project",
                options: [
                  {
                    id: "new",
                    value: "new",
                    label: "Create a new project",
                    hint: `Named ${agentName}`,
                  },
                  { id: "link", value: "link", label: "Link an existing project" },
                ],
                recommended: "new",
                required: true,
              }),
            )));
      if (choice === "new") {
        const requestedName = editableChoice?.kind === "edited" ? editableChoice.text : agentName;
        const project = await deps.pickNewProjectName(prompter, parent(), team, requestedName, {
          signal,
        });
        return {
          vercelProject: { kind: "new", project, team },
          aiGateway: { kind: "inherit" },
          modelWiring: "gateway",
        };
      }
      const pickedProject = await deps.pickProject(prompter, parent(), team, {
        allowCreateWhenEmpty: options.projectSelection !== "existing-only",
        signal,
      });
      return {
        vercelProject: {
          kind: pickedProject.exists ? "existing" : "new",
          project: pickedProject.project,
          team,
        },
        aiGateway: { kind: "inherit" },
        modelWiring: "gateway",
      };
    }

    // No Vercel project: the agent still needs a credential for the model it
    // picked earlier, so the provider hint is derived from that model.
    const credential = await options.asker.ask(
      select<"api-key" | "local">({
        key: "credential",
        message: "How should your agent reach the model?",
        options: [
          {
            id: "api-key",
            value: "api-key",
            label: "Use my own AI Gateway API key",
            hint: "AI_GATEWAY_API_KEY",
          },
          {
            id: "local",
            value: "local",
            label: "Use my own provider API key",
            hint: byokProviderEnvVar(state.modelId),
          },
        ],
        recommended: "api-key",
        required: true,
      }),
    );
    if (credential === "api-key") {
      // Sensitive text: the interactive base renders it through the password
      // prompt (masked), every other rung coerces it as plain text. The
      // question's validate runs in both bases.
      const apiGatewayKey = await options.asker.ask(
        text({
          key: "gateway-api-key",
          message: "Enter your AI_GATEWAY_API_KEY",
          sensitive: true,
          validate: (value) => (value.trim().length === 0 ? "API key cannot be empty." : null),
          required: true,
        }),
      );
      return {
        vercelProject: { kind: "none" },
        aiGateway: { kind: "byok", apiGatewayKey },
        modelWiring: "gateway",
      };
    }
    // "Use my own provider API key": no managed credential. The scaffold writes
    // an inline provider `byok` block and the model prompt is skipped.
    return {
      vercelProject: { kind: "none" },
      aiGateway: { kind: "byop" },
      modelWiring: "self",
    };
  }

  return {
    id: "resolve-provisioning",

    async gather({ state, signal }): Promise<ResolvedProvisioning> {
      // A headless run maps flags to plans without ever asking; the headless mode
      // is the same composition-time fact that picked the asker base. An
      // interactive run asks the deploy tree through the asker. Keeping the
      // branch here preserves the dual-face split exactly: headless requires
      // mode.headless and reads the flags, interactive prompts every decision.
      if (options.mode.headless) {
        const plans = await plansFromFlags(
          state.agentName,
          options.mode.project,
          options.mode.aiGateway,
          signal,
        );
        // Flag-driven runs can contradict themselves (--skip-vercel with a
        // selection that needs a project); refuse here, before any filesystem
        // write. Interactive runs cannot reach this state: the prompt tree
        // resolves to Vercel for those selections.
        if (plans.vercelProject.kind === "none") {
          const demands = vercelDemands(state);
          if (demands.slack) {
            throw new Error("Slack requires a Vercel project. Remove --skip-vercel to add Slack.");
          }
          if (demands.connectSlugs.length > 0) {
            throw new Error(
              `${connectClause(demands.connectSlugs)}, which needs a Vercel project. Remove --skip-vercel to add ${demands.connectSlugs.length === 1 ? "it" : "them"}.`,
            );
          }
        }
        return plans;
      }
      return promptPlans(state, signal);
    },

    async perform({ input }): Promise<ResolvedProvisioning> {
      return input;
    },

    apply(state, payload) {
      return {
        ...state,
        vercelProject: payload.vercelProject,
        aiGateway: payload.aiGateway,
        modelWiring: payload.modelWiring,
        project:
          payload.project === undefined
            ? state.project
            : mergeProjectResolution(state.project, payload.project),
      };
    },
  };
}
