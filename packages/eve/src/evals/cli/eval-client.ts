import { Client } from "#client/client.js";
import type { ClientOptions } from "#client/types.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";

import type { EveEvalTargetHandle } from "#evals/types.js";

/**
 * Resolves the {@link ClientOptions} for an eval target.
 *
 * Local targets need no auth. Remote targets connect with the same options
 * as every other development client (`resolveDevelopmentClientOptions`):
 * per-request headers carrying the Vercel OIDC trusted-IDP token (which
 * bypasses Deployment Protection without a per-project secret) plus
 * `x-vercel-protection-bypass` when `VERCEL_AUTOMATION_BYPASS_SECRET` is
 * set, and a bearer resolved from the same OIDC cascade.
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

/**
 * Creates the eve {@link Client} for an eval target from
 * {@link resolveEvalClientOptions}.
 */
export function createEvalClient(target: Pick<EveEvalTargetHandle, "kind" | "url">): Client {
  return new Client(resolveEvalClientOptions(target));
}
