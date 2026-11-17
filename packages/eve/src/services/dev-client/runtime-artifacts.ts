import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
} from "#protocol/routes.js";

export async function readDevelopmentRuntimeArtifactsRevision(input: {
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<string | undefined> {
  try {
    const url = new URL(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, input.serverUrl);
    const timeoutSignal =
      input.timeoutMs === undefined ? undefined : AbortSignal.timeout(input.timeoutMs);
    const signal =
      input.signal === undefined
        ? timeoutSignal
        : timeoutSignal === undefined
          ? input.signal
          : AbortSignal.any([input.signal, timeoutSignal]);
    const request: RequestInit = { redirect: "error" };
    if (signal !== undefined) request.signal = signal;
    const response = await fetch(url, request);
    return await parseDevelopmentRuntimeArtifactsRevision(response);
  } catch {
    return undefined;
  }
}

export async function suspendDevelopmentRuntimeArtifacts(input: {
  readonly leaseId: string;
  readonly serverUrl: string;
}): Promise<boolean> {
  return await changeDevelopmentRuntimeArtifacts(
    input.serverUrl,
    EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
    input.leaseId,
  );
}

export async function resumeDevelopmentRuntimeArtifacts(input: {
  readonly leaseId: string;
  readonly serverUrl: string;
  readonly silent?: boolean;
}): Promise<string | undefined> {
  try {
    const url = new URL(EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH, input.serverUrl);
    url.searchParams.set("lease", input.leaseId);
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
  leaseId: string,
): Promise<boolean> {
  try {
    const url = new URL(path, serverUrl);
    url.searchParams.set("lease", leaseId);
    const response = await fetch(url, { method: "POST" });
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
