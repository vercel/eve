import { captureVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
import { z } from "zod";

const VercelDeploymentSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  target: z.string().nullable().optional(),
  customEnvironment: z
    .object({ slug: z.string().min(1) })
    .nullable()
    .optional(),
});
const VercelApiErrorSchema = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
  }),
});

const verifiedVercelTargetBrand: unique symbol = Symbol("VerifiedVercelTarget");

export interface ResolvedVercelDeployment {
  readonly provider: "vercel";
  readonly ownerId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environment: string;
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
  | {
      readonly kind: "project-mismatch";
      readonly expectedProjectId: string;
      readonly actualProjectId: string;
    }
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

function isNotFoundApiFailure(failure: VercelCaptureFailure): boolean {
  if (failure.code === 404) return true;

  try {
    const parsed = VercelApiErrorSchema.safeParse(JSON.parse(failure.stdout));
    if (!parsed.success) return false;
    const code = String(parsed.data.error.code ?? "").toLowerCase();
    const message = parsed.data.error.message?.toLowerCase() ?? "";
    return code === "404" || code === "not_found" || message.includes("not found");
  } catch {
    return false;
  }
}

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
  readonly source?: Pick<VercelProjectReference, "orgId" | "projectId">;
  readonly signal?: AbortSignal;
  readonly deps?: Partial<VercelDeploymentResolutionDeps>;
}): Promise<VercelDeploymentResolution> {
  const deps = { ...defaultDeps, ...input.deps };
  const source = input.source ?? (await deps.readProjectLink(input.workspaceRoot));
  if (source === undefined) return { kind: "unscoped" };

  const result = await deps.captureVercel(
    ["api", `/v13/deployments/${encodeURIComponent(input.host)}`, "--scope", source.orgId, "--raw"],
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

  if (parsed.data.projectId !== source.projectId) {
    return {
      kind: "project-mismatch",
      expectedProjectId: source.projectId,
      actualProjectId: parsed.data.projectId,
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
        ownerId: source.orgId,
        projectId: parsed.data.projectId,
        projectName: parsed.data.name,
        environment: environmentForDeployment(parsed.data),
      },
    },
  };
}
