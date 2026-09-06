/** Resolves this fixture's HTTP service in local and deployed workflow workers. */
export function fakeServiceUrl(service: string): URL {
  const origin =
    process.env.WORKFLOW_LOCAL_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (origin === undefined) throw new Error("Fixture service origin is unavailable");
  const prefix = process.env.EVE_PUBLIC_ROUTE_PREFIX ?? "";
  const url = new URL(`${prefix}/fixture-service/${encodeURIComponent(service)}`, origin);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) url.searchParams.set("x-vercel-protection-bypass", bypass);
  return url;
}
