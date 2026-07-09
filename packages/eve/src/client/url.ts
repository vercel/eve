/**
 * Builds a fetchable URL from a caller-provided host and an eve route path.
 *
 * `host` may be an absolute origin (`https://agent.example.com`) or a
 * same-origin prefix (`/api`). Prefixes are important for browser clients that
 * talk to an app-owned proxy instead of the eve deployment directly.
 */
export function createClientUrl(
  host: string,
  routePath: string,
  searchParams?: Readonly<Record<string, string>>,
): string {
  const normalizedRoute = routePath.startsWith("/") ? routePath : `/${routePath}`;

  if (isAbsoluteUrl(host)) {
    const url = new URL(host);
    const basePath = trimTrailingSlash(url.pathname);
    url.pathname = `${basePath}${normalizedRoute}`;
    mergeSearchParams(url.searchParams, searchParams);
    url.hash = "";
    return url.toString();
  }

  const url = new URL(host, "http://eve.local");
  const basePath = trimTrailingSlash(url.pathname);
  mergeSearchParams(url.searchParams, searchParams);
  return `${basePath}${normalizedRoute}${formatSearch(url.searchParams)}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:/i.test(value);
}

function trimTrailingSlash(value: string): string {
  if (value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function mergeSearchParams(
  target: URLSearchParams,
  searchParams: Readonly<Record<string, string>> | undefined,
): void {
  if (searchParams === undefined) return;

  for (const [name, value] of Object.entries(searchParams)) {
    target.set(name, value);
  }
}

function formatSearch(searchParams: URLSearchParams): string {
  const value = searchParams.toString();
  return value.length === 0 ? "" : `?${value}`;
}
