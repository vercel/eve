import { Client } from "#client/client.js";
import type { ClientOptions } from "#client/types.js";
import { resolveEveEvaluationRunId } from "#internal/application/dev-environment.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClientDeps,
} from "#setup/verified-remote-client.js";

import type { EveEvalTargetHandle } from "#evals/types.js";

/**
 * Synchronous {@link ClientOptions} for an eval target: local sends the
 * run id as a bearer so the in-process server authenticates the harness as
 * a synthetic eval user (`principalType: "user"`), letting user-scoped
 * interactive authorization park instead of failing on `local-dev`. Remote
 * stays anonymous unless `EVE_EVAL_AUTH_TOKEN` sets a static bearer.
 * Ambient Vercel credentials need the async {@link createEvalClient}.
 */
export function resolveEvalClientOptions(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
): ClientOptions {
  if (target.kind === "local") {
    const runId = resolveEveEvaluationRunId();
    return runId === undefined
      ? { host: target.url }
      : { host: target.url, auth: { bearer: runId } };
  }

  const options = resolveDevelopmentClientOptions(target.url);
  const explicitToken = process.env.EVE_EVAL_AUTH_TOKEN?.trim();
  if (explicitToken) {
    return { ...options, auth: { bearer: explicitToken }, redirect: "manual" };
  }

  return options;
}

export interface CreateEvalClientOptions {
  /** Working directory for Vercel lookup and the fallback on-disk project link. */
  readonly workspaceRoot?: string;
  /** Test seams for the two authority-resolution boundaries. */
  readonly deps?: Partial<VerifiedRemoteDevelopmentClientDeps>;
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

  const { options: verified } = await resolveVerifiedRemoteDevelopmentClient({
    serverUrl: target.url,
    workspaceRoot: options.workspaceRoot,
    deps: options.deps,
  });
  return new Client({
    ...base,
    ...verified,
  });
}
