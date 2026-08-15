import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
} from "#protocol/routes.js";

/**
 * Reads the dev server's runtime-artifacts revision — an opaque token that
 * changes whenever the authored-source watcher recompiles (HMR). Consumers
 * compare successive values to detect "the agent changed under me" and
 * refresh the development UI before the next turn.
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
    const response = await fetch(url);
    return await parseDevelopmentRuntimeArtifactsRevision(response);
  } catch {
    return undefined;
  }
}

export async function suspendDevelopmentRuntimeArtifacts(input: {
  readonly serverUrl: string;
}): Promise<boolean> {
  return await changeDevelopmentRuntimeArtifacts(
    input.serverUrl,
    EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  );
}

export async function resumeDevelopmentRuntimeArtifacts(input: {
  readonly serverUrl: string;
  readonly silent?: boolean;
}): Promise<string | undefined> {
  try {
    const url = new URL(EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH, input.serverUrl);
    if (input.silent === true) url.searchParams.set("silent", "1");
    const response = await fetch(url, { method: "POST" });
    return await parseDevelopmentRuntimeArtifactsRevision(response);
  } catch {
    return undefined;
  }
}

async function changeDevelopmentRuntimeArtifacts(
  serverUrl: string,
  path: string,
): Promise<boolean> {
  try {
    const response = await fetch(new URL(path, serverUrl), { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function rebuildDevelopmentRuntimeArtifacts(input: {
  readonly force?: boolean;
  readonly serverUrl: string;
}): Promise<string | undefined> {
  try {
    const url = new URL(EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH, input.serverUrl);
    if (input.force === true) url.searchParams.set("force", "1");
    const response = await fetch(url, { method: "POST" });
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
