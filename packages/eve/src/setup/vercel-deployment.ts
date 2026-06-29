import { captureVercel, type VercelCaptureFailure } from "#setup/primitives/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { z } from "zod";

import {
  isForbiddenApiFailure,
  isNotFoundApiFailure,
  normalizeVercelApiResult,
} from "./vercel-api-failure.js";

const VercelDeploymentSchema = z.object({
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  target: z.string().nullable().optional(),
  customEnvironment: z
    .object({ slug: z.string().min(1) })
    .nullable()
    .optional(),
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
  | { readonly kind: "forbidden" }
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
}

type VercelDeploymentLookupScope =
  | {
      /** An explicit Vercel scope selected for this lookup. */
      readonly scope?: string;
      readonly source?: never;
    }
  | {
      /** A known project source, which also cross-checks the returned project id. */
      readonly scope?: never;
      readonly source: Pick<VercelProjectReference, "orgId" | "projectId">;
    };

const defaultDeps: VercelDeploymentResolutionDeps = { captureVercel };
const DEPLOYMENT_LOOKUP_TIMEOUT_MS = 10_000;

function environmentForDeployment(deployment: z.infer<typeof VercelDeploymentSchema>): string {
  if (deployment.customEnvironment !== null && deployment.customEnvironment !== undefined) {
    return deployment.customEnvironment.slug;
  }
  return deployment.target === "production" ? "production" : "preview";
}

/** Resolves a Vercel deployment URL to its project and target environment. */
export async function resolveVercelDeployment(
  input: {
    readonly workspaceRoot: string;
    readonly host: string;
    readonly signal?: AbortSignal;
    readonly deps?: Partial<VercelDeploymentResolutionDeps>;
  } & VercelDeploymentLookupScope,
): Promise<VercelDeploymentResolution> {
  const deps = { ...defaultDeps, ...input.deps };
  // A deployment hostname is globally unique, so Vercel resolves it under the
  // caller's own access without a scope. A selected scope repeats that lookup
  // for one team; a known project source also cross-checks the returned project.
  const source = input.source;
  const scope = input.scope ?? source?.orgId;

  const result = normalizeVercelApiResult(
    await deps.captureVercel(
      [
        "api",
        `/v13/deployments/${encodeURIComponent(input.host)}`,
        ...(scope !== undefined ? ["--scope", scope] : []),
        "--raw",
      ],
      {
        cwd: input.workspaceRoot,
        nonInteractive: true,
        signal: input.signal,
        timeoutMs: DEPLOYMENT_LOOKUP_TIMEOUT_MS,
      },
    ),
  );
  if (!result.ok) {
    if (input.signal?.aborted === true || result.failure.errno === "ABORT_ERR") {
      return { kind: "cancelled" };
    }
    if (isNotFoundApiFailure(result.failure)) return { kind: "not-found" };
    // A denied scope (e.g. an expired team SSO session) is distinct from a
    // genuine miss: the caller can re-authenticate and retry.
    if (isForbiddenApiFailure(result.failure)) return { kind: "forbidden" };
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

  if (source !== undefined && parsed.data.projectId !== source.projectId) {
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
        // The OIDC `owner_id` claim and Trusted Sources key on the canonical
        // team/owner id. Vercel's response carries it, so the verified target
        // takes the owner from there rather than from any scope the caller may
        // have queried with (which can be a slug).
        ownerId: parsed.data.ownerId,
        projectId: parsed.data.projectId,
        projectName: parsed.data.name,
        environment: environmentForDeployment(parsed.data),
      },
    },
  };
}
