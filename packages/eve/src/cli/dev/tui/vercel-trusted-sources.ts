import {
  updateProjectTrustedSourcesFromJSON,
  type UpdateProjectTrustedSources,
} from "@vercel/sdk/models/updateprojectprojectsaction.js";
import { trustedSourcesToJSON } from "@vercel/sdk/models/updateprojectprojectsoptionsallowlist.js";
import { captureVercel } from "#setup/primitives/index.js";
import type { Prompter } from "#setup/prompter.js";
import { normalizeVercelApiResult } from "#setup/vercel-api-failure.js";
import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";
import { z } from "zod";

import {
  planTrustedSourceAccess,
  type TrustedSourceProject,
} from "./vercel-trusted-sources-policy.js";

type VercelTrustedSourcePreparation =
  | { readonly kind: "unchanged" }
  | { readonly kind: "approved"; readonly grant: VercelTrustedSourceGrant }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

type VercelTrustedSourceApplication =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "updated";
      readonly targetProjectName: string;
    }
  | { readonly kind: "failed"; readonly message: string };

export interface VercelTrustedSourceGrant {
  readonly ownerId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly targetEnvironment: string;
}

export interface VercelTrustedSourceDeps {
  readonly captureVercel: typeof captureVercel;
}

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  customEnvironments: z.array(z.object({ slug: z.string().min(1) })).optional(),
  trustedSources: z.unknown().nullable().optional(),
});

type VercelProject = Omit<z.infer<typeof ProjectSchema>, "trustedSources"> & {
  readonly trustedSources?: UpdateProjectTrustedSources;
};

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function parseTrustedSources(value: unknown): UpdateProjectTrustedSources | undefined {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  const parsed = updateProjectTrustedSourcesFromJSON(json);
  return parsed.ok ? parsed.value : undefined;
}

function parseProject(stdout: string): VercelProject | undefined {
  const parsed = ProjectSchema.safeParse(parseJson(stdout));
  if (!parsed.success) return undefined;

  const { trustedSources, ...project } = parsed.data;
  if (trustedSources === undefined || trustedSources === null) return project;

  const policy = parseTrustedSources(trustedSources);
  return policy === undefined ? undefined : { ...project, trustedSources: policy };
}
const ProjectUpdateSchema = z.object({ id: z.string().min(1) });

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

function projectPolicyContext(project: VercelProject): TrustedSourceProject {
  return {
    projectId: project.id,
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
  | { readonly kind: "project"; readonly project: VercelProject }
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
  const project = parseProject(result.stdout);
  if (project === undefined || project.id !== input.projectId) {
    return { kind: "failed", message: "Vercel returned an invalid project response." };
  }
  return { kind: "project", project };
}

/** Confirms a Trusted Sources grant for one verified target project. */
export async function prepareVercelTrustedSourceAccess(input: {
  readonly workspaceRoot: string;
  readonly target: VerifiedVercelTarget;
  readonly prompter: Prompter;
  readonly signal?: AbortSignal;
  readonly deps?: Partial<VercelTrustedSourceDeps>;
}): Promise<VercelTrustedSourcePreparation> {
  const deps: VercelTrustedSourceDeps = { ...defaultDeps, ...input.deps };
  const deployment = input.target.deployment;

  // A local project-scoped OIDC token represents the Development environment.
  const projectResult = await readProject({
    deps,
    workspaceRoot: input.workspaceRoot,
    ownerId: deployment.ownerId,
    projectId: deployment.projectId,
    signal: input.signal,
  });
  if (projectResult.kind === "failed") {
    return {
      kind: "failed",
      message: `Could not read Deployment Protection for ${deployment.projectName}: ${projectResult.message}`,
    };
  }
  const { project } = projectResult;
  const plan = planTrustedSourceAccess({
    project: projectPolicyContext(project),
    targetEnvironment: deployment.environment,
    trustedSources: project.trustedSources ?? undefined,
  });
  if (plan.kind === "unchanged") return { kind: "unchanged" };

  const sourceEnvironment = environmentLabel("development");
  const targetEnvironment = environmentLabel(deployment.environment);
  const decision = await input.prompter.select<"continue" | "cancel">({
    message: `Allow ${sourceEnvironment} from ${project.name} to access ${targetEnvironment} deployments of ${project.name}?`,
    hintLayout: "stacked",
    notices: [
      {
        tone: "warning",
        text: `This changes Deployment Protection for ${project.name} until the Trusted Sources rule is removed.`,
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
      ownerId: deployment.ownerId,
      projectId: project.id,
      projectName: project.name,
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
  const projectResult = await readProject({
    deps,
    workspaceRoot: input.workspaceRoot,
    ownerId: input.grant.ownerId,
    projectId: input.grant.projectId,
    signal: input.signal,
  });
  if (projectResult.kind === "failed") {
    return {
      kind: "failed",
      message: `Could not refresh Deployment Protection for ${input.grant.projectName}: ${projectResult.message}`,
    };
  }
  const { project } = projectResult;
  const plan = planTrustedSourceAccess({
    project: projectPolicyContext(project),
    targetEnvironment: input.grant.targetEnvironment,
    trustedSources: project.trustedSources ?? undefined,
  });
  if (plan.kind === "unchanged") return { kind: "unchanged" };

  const updateResult = normalizeVercelApiResult(
    await deps.captureVercel(
      [
        "api",
        `/v9/projects/${encodeURIComponent(project.id)}`,
        "--scope",
        input.grant.ownerId,
        "--method",
        "PATCH",
        "--field",
        `trustedSources=${trustedSourcesToJSON(plan.trustedSources)}`,
        "--raw",
      ],
      {
        cwd: input.workspaceRoot,
        nonInteractive: true,
        signal: input.signal,
      },
    ),
  );
  if (!updateResult.ok) {
    return {
      kind: "failed",
      message: `Could not update Trusted Sources for ${project.name}: ${updateResult.failure.message}`,
    };
  }
  const parsedUpdate = ProjectUpdateSchema.safeParse(parseJson(updateResult.stdout));
  const updatedProject = parsedUpdate.success ? parsedUpdate.data : undefined;
  if (updatedProject?.id !== project.id) {
    return { kind: "failed", message: "Vercel returned an invalid project response." };
  }

  return {
    kind: "updated",
    targetProjectName: project.name,
  };
}
