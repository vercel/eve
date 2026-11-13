import { Client } from "#client/client.js";
import type { ClientAuth, ClientOptions } from "#client/types.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClientDeps,
} from "#setup/verified-remote-client.js";

import type { EveEvalTargetHandle } from "#evals/types.js";

/**
 * Synchronous {@link ClientOptions} for an eval target. The config's
 * `targetAuth` applies to local and remote targets; on a remote target,
 * `EVE_EVAL_AUTH_TOKEN` (static bearer) or `EVE_EVAL_OIDC_TOKEN` (Vercel
 * Trusted Sources) takes precedence. Without any of them, local needs no auth
 * and remote stays anonymous here; ambient Vercel credentials need the async
 * {@link createEvalClient}.
 */
export function resolveEvalClientOptions(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  targetAuth?: ClientAuth,
): ClientOptions {
  if (target.kind === "local") {
    return targetAuth === undefined
      ? { baseUrl: target.url }
      : { baseUrl: target.url, auth: targetAuth, redirect: "manual" };
  }

  const options = resolveDevelopmentClientOptions(target.url);
  const explicitToken = process.env.EVE_EVAL_AUTH_TOKEN?.trim();
  const oidcToken = process.env.EVE_EVAL_OIDC_TOKEN?.trim();
  if (explicitToken && oidcToken) {
    throw new Error(
      "Set either EVE_EVAL_AUTH_TOKEN or EVE_EVAL_OIDC_TOKEN, not both: each one replaces the remote target's authorization.",
    );
  }
  if (explicitToken) {
    return { ...options, auth: { bearer: explicitToken }, redirect: "manual" };
  }
  if (oidcToken) {
    return { ...options, auth: { vercelOidc: { token: oidcToken } }, redirect: "manual" };
  }
  if (targetAuth !== undefined) {
    return { ...options, auth: targetAuth, redirect: "manual" };
  }

  return options;
}

interface CreateEvalClientOptions {
  /** Working directory for Vercel lookup and the fallback on-disk project link. */
  readonly workspaceRoot?: string;
  /** Credentials from the eval config's `targetAuth`. */
  readonly targetAuth?: ClientAuth;
  /** Test seams for the two authority-resolution boundaries. */
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
}

/** Creates one eval client, authorizing ambient Vercel credentials only after origin proof. */
export async function createEvalClient(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  options: CreateEvalClientOptions = {},
): Promise<Client> {
  const base = resolveEvalClientOptions(target, options.targetAuth);
  if (target.kind === "local" || base.auth !== undefined || options.workspaceRoot === undefined) {
    return new Client(base);
  }

  const orgId = process.env.VERCEL_ORG_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  const projectSource =
    orgId && projectId ? { orgId, projectId } : await readVercelProjectLink(options.workspaceRoot);

  const { options: verified } = await resolveVerifiedRemoteDevelopmentClient({
    projectSource,
    serverUrl: target.url,
    workspaceRoot: options.workspaceRoot,
    deps: options.deps,
  });
  return new Client({
    ...base,
    ...verified,
  });
}
