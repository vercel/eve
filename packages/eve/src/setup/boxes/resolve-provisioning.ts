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
  resolveProjectByNameOrId,
  resolveTeam,
  validateTeam,
} from "../vercel-project.js";
import { withSpinner } from "../with-spinner.js";
import type { VercelTeamRequirement } from "../vercel-project-api.js";

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
  resolveProjectByNameOrId: typeof resolveProjectByNameOrId;
}

export interface ResolveProvisioningOptions {
  asker: Asker;
  prompter: Prompter;
  targetDirectory?: string;
  mode: ProvisioningMode;
  adoptExistingLink?: boolean;
  projectSelection?: "create-or-link" | "existing-only";
  teamSelectMessage?: (currentTeam: string) => string;
  teamRequirement?: VercelTeamRequirement;
  deps?: ResolveProvisioningDeps;
}

interface ResolvedProvisioning {
  vercelProject: ResolvedVercelProject;
  aiGateway: ResolvedAiGateway;
  modelWiring: WiringMode;
  project?: ProjectResolution;
}

interface VercelDemands {
  connectSlugs: string[];
}

function vercelDemands(state: Readonly<SetupState>): VercelDemands {
  return {
    connectSlugs: state.connectionSelection
      .filter((plan) => plan.entry.auth?.kind === "connect")
      .map((plan) => plan.slug),
  };
}

function connectClause(connectSlugs: readonly string[]): string {
  const verb = connectSlugs.length === 1 ? "authenticates" : "authenticate";
  return `${connectSlugs.join(", ")} ${verb} through Vercel Connect`;
}

function vercelRequirements(demands: VercelDemands): string[] {
  const reasons: string[] = [];
  if (demands.connectSlugs.length > 0) {
    reasons.push(connectClause(demands.connectSlugs));
  }
  return reasons;
}

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
    resolveProjectByNameOrId,
  };
  const parent = (): string => resolve(options.targetDirectory ?? process.cwd());

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
    let vercelProject: ResolvedVercelProject;
    if (projectArgs.project === undefined) {
      vercelProject = { kind: "new", project: agentName, team };
    } else {
      const project = await deps.resolveProjectByNameOrId(parent(), team, projectArgs.project, {
        signal,
      });
      if (project === null) {
        throw new Error(`Vercel project "${projectArgs.project}" was not found in ${team}.`);
      }
      vercelProject = { kind: "existing", project, team };
    }
    if (vercelProject.kind === "new") {
      await deps.assertNewProjectNameAvailable(parent(), team, vercelProject.project, { signal });
    }
    return { vercelProject, aiGateway, modelWiring: "gateway" };
  }

  async function promptPlans(
    state: Readonly<SetupState>,
    signal?: AbortSignal,
  ): Promise<ResolvedProvisioning> {
    const prompter = options.prompter;
    const agentName = state.agentName;
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
      const teamOptions = {
        signal,
        selectMessage: options.teamSelectMessage,
        teamRequirement: options.teamRequirement,
      };
      const team = await deps.pickTeam(prompter, parent(), undefined, teamOptions);
      const projectOptions = [
        {
          value: "new" as const,
          label: "Create a new project",
          hint: `Name: ${agentName}`,
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
                formatHint: (value) => `Name: ${value}`,
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
                    hint: `Name: ${agentName}`,
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
        suggestedName: agentName,
        signal,
      });
      return {
        vercelProject: pickedProject,
        aiGateway: { kind: "inherit" },
        modelWiring: "gateway",
      };
    }

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
      const apiGatewayKey = await options.asker.ask(
        text({
          key: "gateway-api-key",
          message: "Enter your AI_GATEWAY_API_KEY",
          sensitive: true,
          environment: "AI_GATEWAY_API_KEY",
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
    return {
      vercelProject: { kind: "none" },
      aiGateway: { kind: "byop" },
      modelWiring: "self",
    };
  }

  return {
    id: "resolve-provisioning",

    async gather({ state, signal }): Promise<ResolvedProvisioning> {
      if (options.mode.headless) {
        const plans = await plansFromFlags(
          state.agentName,
          options.mode.project,
          options.mode.aiGateway,
          signal,
        );
        if (plans.vercelProject.kind === "none") {
          const demands = vercelDemands(state);
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
