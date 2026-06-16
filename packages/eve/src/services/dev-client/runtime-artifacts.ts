import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
} from "#protocol/routes.js";

import { resolveDevelopmentClientHeaders } from "./request-headers.js";

/**
 * Reads the dev server's runtime-artifacts revision — an opaque token that
 * changes whenever the authored-source watcher recompiles (HMR). Consumers
 * compare successive values to detect "the agent changed under me": the dev
 * client rotates an active session before the next turn or while idle.
 *
 * Never throws: any transport failure, non-2xx response, or malformed body
 * resolves to `undefined`, so callers treat "unknown" and "unreachable" the
 * same way.
 */
export async function readDevelopmentRuntimeArtifactsRevision(input: {
  readonly serverUrl: string;
}): Promise<string | undefined> {
  try {
    const url = new URL(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, input.serverUrl);
    const response = await fetch(url, {
      headers: await resolveDevelopmentClientHeaders({ serverUrl: input.serverUrl }),
    });
    return await parseDevelopmentRuntimeArtifactsRevision(response);
  } catch {
    return undefined;
  }
}

export async function rebuildDevelopmentRuntimeArtifacts(input: {
  readonly serverUrl: string;
}): Promise<string | undefined> {
  try {
    const url = new URL(EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH, input.serverUrl);
    const response = await fetch(url, {
      headers: await resolveDevelopmentClientHeaders({ serverUrl: input.serverUrl }),
      method: "POST",
    });
    return await parseDevelopmentRuntimeArtifactsRevision(response);
  } catch {
    return undefined;
  }
}

async function parseDevelopmentRuntimeArtifactsRevision(
  response: Response,
): Promise<string | undefined> {
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { revision?: unknown };
  return typeof body.revision === "string" && body.revision.length > 0 ? body.revision : undefined;
}
