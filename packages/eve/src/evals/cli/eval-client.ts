import { Client } from "#client/client.js";
import type { ClientAuth, ClientOptions, TokenValue } from "#client/types.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClientDeps,
} from "#setup/verified-remote-client.js";

import { runUntilAborted } from "#evals/abort.js";
import { validateEvalTargetAuth } from "#evals/define-eval-config.js";
import type { EveEvalConfigInput, EveEvalTargetHandle } from "#evals/types.js";

const TARGET_AUTH_TIMEOUT_MS = 5_000;

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
    return { ...options, auth: protectTargetAuth(targetAuth), redirect: "manual" };
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
  const auth = await resolveTargetCredential("resolver", () =>
    targetAuth({ kind: target.kind, url }),
  );
  if (auth === undefined) return options;
  validateEvalTargetAuth(auth, "The `targetAuth` resolver result");
  return { ...options, baseUrl, auth: protectTargetAuth(auth), redirect: "manual" };
}

function protectTargetAuth(auth: ClientAuth): ClientAuth {
  if ("bearer" in auth) return { bearer: targetToken(auth.bearer) };
  if ("vercelOidc" in auth) return { vercelOidc: { token: targetToken(auth.vercelOidc.token) } };
  return { basic: { ...auth.basic, password: targetToken(auth.basic.password, true) } };
}

function targetToken(value: TokenValue, basic = false): () => Promise<string> {
  return async () => {
    const token =
      typeof value === "function" ? await resolveTargetCredential("token function", value) : value;
    try {
      if (typeof token !== "string") throw new TypeError();
      if (!basic) new Headers({ authorization: `Bearer ${token.trim()}` });
      return token;
    } catch {
      throw new Error(
        "Eval config `targetAuth` provided an invalid token for the selected auth scheme.",
      );
    }
  };
}

async function resolveTargetCredential<T>(
  source: string,
  resolve: () => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TARGET_AUTH_TIMEOUT_MS);
  try {
    return await runUntilAborted(Promise.resolve().then(resolve), controller.signal);
  } catch {
    const reason = controller.signal.aborted
      ? `timed out after ${TARGET_AUTH_TIMEOUT_MS / 1000} seconds`
      : "failed";
    throw new Error(
      `Eval config \`targetAuth\` ${source} ${reason}. Check the credential provider.`,
    );
  } finally {
    clearTimeout(timeout);
  }
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
