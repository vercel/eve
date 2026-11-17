import { Client } from "#client/client.js";
import type { ClientOptions } from "#client/types.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClientDeps,
} from "#setup/verified-remote-client.js";

import type { EveEvalTargetHandle } from "#evals/types.js";

export function resolveEvalClientOptions(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
): ClientOptions {
  if (target.kind === "local") {
    return { baseUrl: target.url };
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

  return options;
}

interface CreateEvalClientOptions {
  readonly workspaceRoot?: string;
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
}

export async function createEvalClient(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  options: CreateEvalClientOptions = {},
): Promise<Client> {
  const base = resolveEvalClientOptions(target);
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
