import { setTimeout as sleep } from "node:timers/promises";

import { EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH } from "#protocol/routes.js";

const DEFAULT_READINESS_TIMEOUT_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 100;

export interface DevelopmentServerReadiness {
  readonly serverId: string;
}

export async function readDevelopmentServerReadiness(
  serverUrl: string,
  options: {
    readonly expectedServerId?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<DevelopmentServerReadiness | undefined> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

  try {
    const url = new URL(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, serverUrl).toString();
    const response = await fetch(url, { redirect: "error", signal });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object") return undefined;
    const serverId = (payload as Record<string, unknown>).serverId;
    if (typeof serverId !== "string" || serverId.length === 0) return undefined;
    if (options.expectedServerId !== undefined && serverId !== options.expectedServerId) {
      return undefined;
    }
    return { serverId };
  } catch {
    return undefined;
  }
}

export async function waitForDevelopmentServerReadiness(
  serverUrl: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<DevelopmentServerReadiness> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readiness = await readDevelopmentServerReadiness(serverUrl, {
      signal: options.signal,
    });
    if (readiness !== undefined) return readiness;
    await sleep(WAIT_INTERVAL_MS, undefined, { signal: options.signal });
  }
  throw new Error(`eve dev server did not become ready within ${timeoutMs / 1000}s.`);
}
