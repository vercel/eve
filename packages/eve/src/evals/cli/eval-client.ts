import { Client } from "#client/client.js";
import type { ClientOptions } from "#client/types.js";
import {
  resolveDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import { resolveDevelopmentOidcToken } from "#services/dev-client/request-headers.js";
import { resolveVercelDeployment } from "#setup/vercel-deployment.js";

import type { EveEvalTargetHandle } from "#evals/types.js";

/**
 * Resolves the {@link ClientOptions} for an eval target.
 *
 * Local targets need no auth. Remote targets remain anonymous unless the user
 * supplied `EVE_EVAL_AUTH_TOKEN`; ambient Vercel credentials require the
 * authoritative resolution performed by {@link createEvalClient}.
 *
 * `EVE_EVAL_AUTH_TOKEN` overrides the bearer with a static token for
 * targets whose auth is not OIDC-based.
 */
export function resolveEvalClientOptions(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
): ClientOptions {
  if (target.kind === "local") {
    return { host: target.url };
  }

  const options = {
    ...resolveDevelopmentClientOptions(target.url),
    preserveCompletedSessions: false,
  };
  const explicitToken = process.env.EVE_EVAL_AUTH_TOKEN?.trim();
  if (explicitToken) {
    return { ...options, auth: { bearer: explicitToken } };
  }

  return options;
}

export interface CreateEvalClientOptions {
  /** Local Vercel project state used to verify a remote deployment origin. */
  readonly workspaceRoot?: string;
  /** Test seams for the two authority-resolution boundaries. */
  readonly deps?: {
    readonly resolveVercelDeployment?: typeof resolveVercelDeployment;
    readonly resolveDevelopmentOidcToken?: typeof resolveDevelopmentOidcToken;
  };
}

/** Creates one eval client, authorizing ambient Vercel credentials only after origin proof. */
export async function createEvalClient(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
  options: CreateEvalClientOptions = {},
): Promise<Client> {
  const base = resolveEvalClientOptions(target);
  if (target.kind === "local" || base.auth !== undefined || options.workspaceRoot === undefined) {
    return new Client(base);
  }

  const resolveDeployment = options.deps?.resolveVercelDeployment ?? resolveVercelDeployment;
  const resolution = await resolveDeployment({
    workspaceRoot: options.workspaceRoot,
    host: new URL(target.url).host,
  });
  if (resolution.kind !== "resolved") return new Client(base);

  const resolveToken = options.deps?.resolveDevelopmentOidcToken ?? resolveDevelopmentOidcToken;
  const token = (await resolveToken()).trim();
  const credentials = createDevelopmentCredentialGate(target.url);
  credentials.authorize({ target: resolution.target, token });
  return new Client(
    resolveRemoteDevelopmentClientOptions({
      serverUrl: target.url,
      credentials,
    }),
  );
}
