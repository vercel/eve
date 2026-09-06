/** Resolves this fixture's HTTP service in local and deployed workflow workers. */
export function fakeServiceUrl(service: string): URL {
  const origin =
    process.env.WORKFLOW_LOCAL_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ??
    (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : undefined);
  if (origin === undefined) throw new Error("Fixture service origin is unavailable");
  const prefix = process.env.EVE_PUBLIC_ROUTE_PREFIX ?? "";
  const url = new URL(`${prefix}/fixture-service/${encodeURIComponent(service)}`, origin);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) url.searchParams.set("x-vercel-protection-bypass", bypass);
  return url;
}

/** The local world's localhost callback and the eval's loopback IP reach the same server. */
export function fixtureAuthorizationCallback(target: string, callback: string | undefined): URL {
  if (callback === undefined) throw new Error("Authorization probe produced no callback URL");
  const url = new URL(callback);
  const targetUrl = new URL(target);
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.protocol === "http:" &&
    targetUrl.protocol === "http:" &&
    loopback.has(url.hostname) &&
    loopback.has(targetUrl.hostname)
  ) {
    url.hostname = targetUrl.hostname;
  }
  if (url.origin !== targetUrl.origin)
    throw new Error("Expected the fixture authorization callback on this deployment");
  return url;
}
