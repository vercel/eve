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
  const queryIndex = routePath.indexOf("?");
  const pathPart = queryIndex === -1 ? routePath : routePath.slice(0, queryIndex);
  const embeddedSearch = queryIndex === -1 ? "" : routePath.slice(queryIndex);
  const normalizedRoute = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  // Explicit searchParams win; otherwise preserve a query string already on the
  // route path (e.g. the realtime-speech setup URL's `?voiceSessionId=`), which
  // the URL pathname setter would otherwise percent-encode for absolute hosts.
  const search =
    searchParams && Object.keys(searchParams).length > 0
      ? formatSearch(searchParams)
      : embeddedSearch;

  if (isAbsoluteUrl(host)) {
    const url = new URL(host);
    const basePath = trimTrailingSlash(url.pathname);
    url.pathname = `${basePath}${normalizedRoute}`;
    url.search = search;
    url.hash = "";
    return url.toString();
  }

  return `${trimTrailingSlash(host)}${normalizedRoute}${search}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:/i.test(value);
}

function trimTrailingSlash(value: string): string {
  if (value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function formatSearch(searchParams: Readonly<Record<string, string>> | undefined): string {
  if (!searchParams || Object.keys(searchParams).length === 0) {
    return "";
  }

  return `?${new URLSearchParams(searchParams).toString()}`;
}
