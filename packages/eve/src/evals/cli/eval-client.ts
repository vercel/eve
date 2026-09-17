import { Client } from "#client/client.js";
import type { ClientOptions, HeadersValue } from "#client/types.js";
import { EVE_EVAL_HEADER, EVE_EVAL_HEADER_VALUE } from "#internal/evaluation.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClientDeps,
} from "#setup/verified-remote-client.js";

import type { EveEvalTargetHandle } from "#evals/types.js";

/**
 * Synchronous {@link ClientOptions} for an eval target: local needs no auth,
 * remote stays anonymous unless `EVE_EVAL_AUTH_TOKEN` sets a static bearer.
 * Ambient Vercel credentials need the async {@link createEvalClient}.
 */
export function resolveEvalClientOptions(
  target: Pick<EveEvalTargetHandle, "kind" | "url">,
): ClientOptions {
  if (target.kind === "local") {
    return { host: target.url, headers: { [EVE_EVAL_HEADER]: EVE_EVAL_HEADER_VALUE } };
  }

  const options = resolveDevelopmentClientOptions(target.url);
  const explicitToken = process.env.EVE_EVAL_AUTH_TOKEN?.trim();
  if (explicitToken) {
    return {
      ...options,
      auth: { bearer: explicitToken },
      headers: { [EVE_EVAL_HEADER]: EVE_EVAL_HEADER_VALUE },
      redirect: "manual",
    };
  }

  return { ...options, headers: { [EVE_EVAL_HEADER]: EVE_EVAL_HEADER_VALUE } };
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
    headers: mergeHeaders(base.headers, verified.headers),
  });
}

function mergeHeaders(
  first: HeadersValue | undefined,
  second: HeadersValue | undefined,
): HeadersValue | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return async () => ({
    ...(await resolveHeaders(first)),
    ...(await resolveHeaders(second)),
    [EVE_EVAL_HEADER]: EVE_EVAL_HEADER_VALUE,
  });
}

async function resolveHeaders(headers: HeadersValue): Promise<Readonly<Record<string, string>>> {
  return typeof headers === "function" ? await headers() : headers;
}
