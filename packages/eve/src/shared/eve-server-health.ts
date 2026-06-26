import { EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";

const DEFAULT_EVE_SERVER_HEALTH_TIMEOUT_MS = 1_000;

/** Returns whether an Eve server answers its health route successfully. */
export async function isEveServerHealthy(
  serverUrl: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const timeoutSignal = AbortSignal.timeout(
    options.timeoutMs ?? DEFAULT_EVE_SERVER_HEALTH_TIMEOUT_MS,
  );
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

  try {
    const healthUrl = new URL(EVE_HEALTH_ROUTE_PATH, serverUrl).toString();
    const response = await fetch(healthUrl, { redirect: "error", signal });
    return response.ok;
  } catch {
    return false;
  }
}
