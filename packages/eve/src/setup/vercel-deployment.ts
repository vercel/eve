import { captureVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import { readProjectLink } from "#setup/project-resolution.js";
import type { DeploymentIdentity } from "#shared/deployment-identity.js";
import { z } from "zod";

import { isNotFoundApiFailure } from "./vercel-project-api.js";

const VercelDeploymentSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  target: z.string().nullable().optional(),
  customEnvironment: z
    .object({ slug: z.string().min(1) })
    .nullable()
    .optional(),
});

const verifiedVercelTargetBrand: unique symbol = Symbol("VerifiedVercelTarget");

export interface ResolvedVercelDeployment extends DeploymentIdentity {
  readonly projectId: string;
}

/** Proof that Vercel resolved one exact HTTPS origin under an authenticated scope. */
export interface VerifiedVercelTarget {
  readonly [verifiedVercelTargetBrand]: true;
  readonly origin: `https://${string}`;
  readonly deployment: ResolvedVercelDeployment;
}

export type VercelDeploymentResolutionFailure =
  | { readonly cause: "vercel"; readonly failure: VercelCaptureFailure }
  | { readonly cause: "invalid-json" | "invalid-shape"; readonly message: string };

export type VercelDeploymentResolution =
  | { readonly kind: "resolved"; readonly target: VerifiedVercelTarget }
  | { readonly kind: "not-found" }
  | { readonly kind: "unscoped" }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "failed";
      readonly failure: VercelDeploymentResolutionFailure;
    };

export interface VercelDeploymentResolutionDeps {
  readonly captureVercel: typeof captureVercel;
  readonly readProjectLink: typeof readProjectLink;
}

const defaultDeps: VercelDeploymentResolutionDeps = { captureVercel, readProjectLink };
const DEPLOYMENT_LOOKUP_TIMEOUT_MS = 10_000;

function environmentForDeployment(deployment: z.infer<typeof VercelDeploymentSchema>): string {
  if (deployment.customEnvironment !== null && deployment.customEnvironment !== undefined) {
    return deployment.customEnvironment.slug;
  }
  return deployment.target === "production" ? "production" : "preview";
}

/** Resolves a Vercel deployment URL to its project and target environment. */
export async function resolveVercelDeployment(input: {
  readonly workspaceRoot: string;
  readonly host: string;
  readonly ownerId?: string;
  readonly signal?: AbortSignal;
  readonly deps?: Partial<VercelDeploymentResolutionDeps>;
}): Promise<VercelDeploymentResolution> {
  const deps = { ...defaultDeps, ...input.deps };
  const ownerId = input.ownerId ?? (await deps.readProjectLink(input.workspaceRoot))?.orgId;
  if (ownerId === undefined) return { kind: "unscoped" };

  const result = await deps.captureVercel(
    ["api", `/v13/deployments/${encodeURIComponent(input.host)}`, "--scope", ownerId, "--raw"],
    {
      cwd: input.workspaceRoot,
      nonInteractive: true,
      signal: input.signal,
      timeoutMs: DEPLOYMENT_LOOKUP_TIMEOUT_MS,
    },
  );
  if (!result.ok) {
    if (input.signal?.aborted === true || result.failure.errno === "ABORT_ERR") {
      return { kind: "cancelled" };
    }
    if (isNotFoundApiFailure(result.failure)) return { kind: "not-found" };
    return { kind: "failed", failure: { cause: "vercel", failure: result.failure } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      kind: "failed",
      failure: { cause: "invalid-json", message: "Vercel returned invalid deployment JSON." },
    };
  }

  const parsed = VercelDeploymentSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      kind: "failed",
      failure: {
        cause: "invalid-shape",
        message: "Vercel returned an invalid deployment response.",
      },
    };
  }

  const normalizedHost = new URL(`https://${input.host}`).host;
  const origin: `https://${string}` = `https://${normalizedHost}`;
  return {
    kind: "resolved",
    target: {
      [verifiedVercelTargetBrand]: true,
      origin,
      deployment: {
        provider: "vercel",
        projectId: parsed.data.projectId,
        projectName: parsed.data.name,
        environment: environmentForDeployment(parsed.data),
      },
    },
  };
}
