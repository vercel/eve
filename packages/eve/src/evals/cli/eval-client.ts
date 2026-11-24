import { Client } from "#client/client.js";
import type { ClientOptions } from "#client/types.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClientDeps,
} from "#setup/verified-remote-client.js";

import { validateEvalTargetAuth } from "#evals/define-eval-config.js";
import type { EveEvalConfigInput, EveEvalTargetHandle } from "#evals/types.js";

interface EvalTargetAuthOptions extends Pick<EveEvalConfigInput, "targetAuth"> {
  readonly onWarning?: (message: string) => void;
}

export async function resolveEvalClientOptions(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  { targetAuth, onWarning }: EvalTargetAuthOptions = {},
): Promise<ClientOptions> {
  const options =
    target.kind === "local" ? { baseUrl: target.url } : resolveDevelopmentClientOptions(target.url);

  if (target.kind === "remote") {
    const explicitToken = process.env.EVE_EVAL_AUTH_TOKEN?.trim();
    const oidcToken = process.env.EVE_EVAL_OIDC_TOKEN?.trim();
    if (explicitToken && oidcToken) {
      throw new Error(
        "Set either EVE_EVAL_AUTH_TOKEN or EVE_EVAL_OIDC_TOKEN, not both: each one replaces the remote target's authorization.",
      );
    }
    const override = explicitToken
      ? { source: "EVE_EVAL_AUTH_TOKEN", auth: { bearer: explicitToken } }
      : oidcToken
        ? { source: "EVE_EVAL_OIDC_TOKEN", auth: { vercelOidc: { token: oidcToken } } }
        : undefined;
    if (override) {
      if (targetAuth !== undefined) {
        onWarning?.(
          `Warning: ${override.source} is set, so this --url run ignores targetAuth in evals.config.ts.`,
        );
      }
      return { ...options, auth: override.auth, redirect: "manual" };
    }
  }

  if (targetAuth === undefined) return options;
  if (typeof targetAuth !== "function") {
    if (target.kind === "remote") {
      throw new Error(
        "Eval config `targetAuth` objects apply only to the local dev server. For --url, use a `targetAuth` function that checks the target's HTTPS origin before returning credentials.",
      );
    }
    return { ...options, auth: targetAuth, redirect: "manual" };
  }

  const url = URL.parse(target.url);
  if (
    !url ||
    (target.kind === "remote" && (url.protocol !== "https:" || url.username || url.password))
  ) {
    throw new Error(
      "Eval config `targetAuth` requires an HTTPS --url without embedded credentials for remote targets.",
    );
  }

  const baseUrl = url.href;
  const auth = await targetAuth({ kind: target.kind, url });
  if (auth === undefined) return options;
  validateEvalTargetAuth(auth, "The `targetAuth` resolver result");
  return { ...options, baseUrl, auth, redirect: "manual" };
}

interface CreateEvalClientOptions extends EvalTargetAuthOptions {
  readonly workspaceRoot?: string;
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
}

export async function createEvalClient(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  options: CreateEvalClientOptions = {},
): Promise<Client> {
  const base = await resolveEvalClientOptions(target, options);
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
