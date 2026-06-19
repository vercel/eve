import { captureVercel } from "#setup/primitives/index.js";
import { z } from "zod";

import type { Prompter } from "./prompter.js";
import type { VerifiedVercelTarget } from "./vercel-deployment.js";
import { parseVercelJsonAs } from "./vercel-project-api.js";
import {
  planTrustedSourceAccess,
  type TrustedSourceAccessPlan,
  type TrustedSourceEndpoint,
  VercelTrustedSourcesSchema,
} from "./vercel-trusted-sources-policy.js";

export type VercelTrustedSourcePreparation =
  | { readonly kind: "unchanged" }
  | { readonly kind: "approved"; readonly grant: VercelTrustedSourceGrant }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

export type VercelTrustedSourceApplication =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "updated";
      readonly targetProjectId: string;
      readonly targetProjectName: string;
    }
  | { readonly kind: "failed"; readonly message: string };

export interface VercelTrustedSourceProject {
  readonly projectId: string;
  readonly scope: string;
}

export interface VercelTrustedSourceGrant {
  readonly scope: string;
  readonly sourceProjectId: string;
  readonly sourceEnvironment: string;
  readonly targetProjectId: string;
  readonly targetProjectName: string;
  readonly targetEnvironment: string;
}

export interface VercelTrustedSourceDeps {
  readonly captureVercel: typeof captureVercel;
}

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  customEnvironments: z.array(z.object({ slug: z.string().min(1) })).optional(),
  trustedSources: VercelTrustedSourcesSchema.nullable().optional(),
});

const defaultDeps: VercelTrustedSourceDeps = { captureVercel };

function environmentLabel(environment: string): string {
  switch (environment) {
    case "development":
      return "Development";
    case "preview":
      return "Preview";
    case "production":
      return "Production";
    default:
      return environment;
  }
}

function projectEndpoint(
  project: z.infer<typeof ProjectSchema>,
  environment: string,
): TrustedSourceEndpoint {
  return {
    projectId: project.id,
    environment,
    customEnvironmentSlugs: project.customEnvironments?.map(({ slug }) => slug) ?? [],
  };
}

async function readProject(input: {
  readonly deps: VercelTrustedSourceDeps;
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
}): Promise<
  | { readonly kind: "project"; readonly project: z.infer<typeof ProjectSchema> }
  | { readonly kind: "failed"; readonly message: string }
> {
  const result = await input.deps.captureVercel(
    [
      "api",
      `/v9/projects/${encodeURIComponent(input.projectId)}`,
      "--scope",
      input.ownerId,
      "--raw",
    ],
    { cwd: input.workspaceRoot, nonInteractive: true, signal: input.signal },
  );
  if (!result.ok) return { kind: "failed", message: result.failure.message };
  const project = parseVercelJsonAs(result.stdout, ProjectSchema);
  return project === undefined
    ? { kind: "failed", message: "Vercel returned an invalid project response." }
    : { kind: "project", project };
}

interface TrustedSourceEndpointRef {
  readonly projectId: string;
  readonly environment: string;
}

type PlanEndpointAccessResult =
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "planned";
      readonly plan: TrustedSourceAccessPlan;
      readonly sourceProject: z.infer<typeof ProjectSchema>;
      readonly targetProject: z.infer<typeof ProjectSchema>;
    };

/**
 * Reads the source and target projects (reusing one read when they coincide)
 * and plans the smallest Trusted Sources change for the endpoint pair. Shared
 * by prepare and apply so the approved plan and the applied plan are computed
 * identically.
 */
async function planEndpointAccess(input: {
  readonly deps: VercelTrustedSourceDeps;
  readonly workspaceRoot: string;
  readonly scope: string;
  readonly source: TrustedSourceEndpointRef;
  readonly target: TrustedSourceEndpointRef;
  readonly describeTargetFailure: (message: string) => string;
  readonly describeSourceFailure: (message: string) => string;
  readonly signal?: AbortSignal;
}): Promise<PlanEndpointAccessResult> {
  const read = (projectId: string) =>
    readProject({
      deps: input.deps,
      workspaceRoot: input.workspaceRoot,
      ownerId: input.scope,
      projectId,
      signal: input.signal,
    });

  const targetResult = await read(input.target.projectId);
  if (targetResult.kind === "failed") {
    return { kind: "failed", message: input.describeTargetFailure(targetResult.message) };
  }
  const sourceResult =
    input.source.projectId === targetResult.project.id
      ? targetResult
      : await read(input.source.projectId);
  if (sourceResult.kind === "failed") {
    return { kind: "failed", message: input.describeSourceFailure(sourceResult.message) };
  }

  const plan = planTrustedSourceAccess({
    source: projectEndpoint(sourceResult.project, input.source.environment),
    target: projectEndpoint(targetResult.project, input.target.environment),
    trustedSources: targetResult.project.trustedSources ?? undefined,
  });
  return {
    kind: "planned",
    plan,
    sourceProject: sourceResult.project,
    targetProject: targetResult.project,
  };
}

/** Confirms a Trusted Sources grant for one resolved source and verified target. */
export async function prepareVercelTrustedSourceAccess(input: {
  readonly workspaceRoot: string;
  readonly sourceProject: VercelTrustedSourceProject;
  readonly target: VerifiedVercelTarget;
  readonly prompter: Prompter;
  readonly signal?: AbortSignal;
  readonly deps?: Partial<VercelTrustedSourceDeps>;
}): Promise<VercelTrustedSourcePreparation> {
  const deps: VercelTrustedSourceDeps = { ...defaultDeps, ...input.deps };
  const { sourceProject } = input;
  const deployment = input.target.deployment;

  // `vercel env pull` mints a Development token, regardless of the target.
  const planned = await planEndpointAccess({
    deps,
    workspaceRoot: input.workspaceRoot,
    scope: sourceProject.scope,
    source: { projectId: sourceProject.projectId, environment: "development" },
    target: { projectId: deployment.projectId, environment: deployment.environment },
    describeTargetFailure: (message) =>
      `Could not read Deployment Protection for ${deployment.projectName}: ${message}`,
    describeSourceFailure: (message) =>
      `Could not read the Vercel project ${sourceProject.projectId}: ${message}`,
    signal: input.signal,
  });
  if (planned.kind === "failed") return planned;
  if (planned.plan.kind === "unchanged") return { kind: "unchanged" };

  const sourceEnvironment = environmentLabel("development");
  const targetEnvironment = environmentLabel(deployment.environment);
  const decision = await input.prompter.select<"continue" | "cancel">({
    message: `Allow ${sourceEnvironment} from ${planned.sourceProject.name} to access ${targetEnvironment} deployments of ${planned.targetProject.name}?`,
    hintLayout: "stacked",
    notices: [
      {
        tone: "warning",
        text: `This changes Deployment Protection for ${planned.targetProject.name} until the Trusted Sources rule is removed.`,
      },
    ],
    options: [
      {
        value: "continue",
        label: "Allow access",
        hint: `Add ${sourceEnvironment} → ${targetEnvironment} to Trusted Sources`,
      },
      {
        value: "cancel",
        label: "Cancel",
        hint: "Leave Deployment Protection unchanged",
      },
    ],
  });
  if (decision === "cancel") return { kind: "cancelled" };

  return {
    kind: "approved",
    grant: {
      scope: sourceProject.scope,
      sourceProjectId: planned.sourceProject.id,
      sourceEnvironment: "development",
      targetProjectId: planned.targetProject.id,
      targetProjectName: planned.targetProject.name,
      targetEnvironment: deployment.environment,
    },
  };
}

/** Applies an approved grant against the target project's latest policy. */
export async function applyVercelTrustedSourceAccess(input: {
  readonly workspaceRoot: string;
  readonly grant: VercelTrustedSourceGrant;
  readonly signal?: AbortSignal;
  readonly deps?: Partial<VercelTrustedSourceDeps>;
}): Promise<VercelTrustedSourceApplication> {
  const deps: VercelTrustedSourceDeps = { ...defaultDeps, ...input.deps };
  const planned = await planEndpointAccess({
    deps,
    workspaceRoot: input.workspaceRoot,
    scope: input.grant.scope,
    source: { projectId: input.grant.sourceProjectId, environment: input.grant.sourceEnvironment },
    target: { projectId: input.grant.targetProjectId, environment: input.grant.targetEnvironment },
    describeTargetFailure: (message) =>
      `Could not refresh Deployment Protection for ${input.grant.targetProjectName}: ${message}`,
    describeSourceFailure: (message) =>
      `Could not refresh the Vercel project ${input.grant.sourceProjectId}: ${message}`,
    signal: input.signal,
  });
  if (planned.kind === "failed") return planned;
  const { plan, targetProject } = planned;
  if (plan.kind === "unchanged") return { kind: "unchanged" };

  const updateResult = await deps.captureVercel(
    [
      "api",
      `/v9/projects/${encodeURIComponent(targetProject.id)}`,
      "--scope",
      input.grant.scope,
      "--method",
      "PATCH",
      "--input",
      "-",
      "--raw",
    ],
    {
      cwd: input.workspaceRoot,
      nonInteractive: true,
      signal: input.signal,
      stdin: JSON.stringify({ trustedSources: plan.trustedSources }),
    },
  );
  if (!updateResult.ok) {
    return {
      kind: "failed",
      message: `Could not update Trusted Sources for ${targetProject.name}: ${updateResult.failure.message}`,
    };
  }
  return {
    kind: "updated",
    targetProjectId: targetProject.id,
    targetProjectName: targetProject.name,
  };
}
