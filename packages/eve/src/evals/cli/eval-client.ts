import { Client } from "#client/client.js";
import type { ClientOptions } from "#client/types.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClientDeps,
} from "#setup/verified-remote-client.js";

import type { EveEvalConfigInput, EveEvalTargetHandle } from "#evals/types.js";

type EvalTargetAuthConfig = Pick<EveEvalConfigInput, "targetAuth" | "targetAuthOrigins">;

export function resolveEvalClientOptions(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  { targetAuth, targetAuthOrigins }: EvalTargetAuthConfig = {},
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

  if (targetAuth === undefined) return options;

  const url = URL.parse(target.url);
  if (
    url?.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !Array.isArray(targetAuthOrigins) ||
    !targetAuthOrigins.includes(url.origin)
  ) {
    throw new Error(
      "Refusing to send workspace targetAuth to this --url. Use an HTTPS URL without embedded credentials and list its exact origin (including any non-default port) in targetAuthOrigins in evals/evals.config.ts.",
    );
  }
  return { ...options, baseUrl: url.href, auth: targetAuth, redirect: "manual" };
}

interface CreateEvalClientOptions extends EvalTargetAuthConfig {
  readonly workspaceRoot?: string;
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
}

export async function createEvalClient(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  options: CreateEvalClientOptions = {},
): Promise<Client> {
  const base = resolveEvalClientOptions(target, options);
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
