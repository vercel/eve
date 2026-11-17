import { joinEveRoutePath } from "#shared/eve-route-path.js";

export function createClientUrl(
  baseUrl: string,
  routePath: string,
  searchParams?: Readonly<Record<string, string>>,
): string {
  const queryIndex = routePath.indexOf("?");
  const pathOnly = queryIndex === -1 ? routePath : routePath.slice(0, queryIndex);
  const embeddedQuery = queryIndex === -1 ? "" : routePath.slice(queryIndex + 1);
  const normalizedRoute = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;

  if (isAbsoluteUrl(baseUrl)) {
    const url = new URL(baseUrl);
    const basePath = trimTrailingSlash(url.pathname);
    url.pathname = joinEveRoutePath(basePath, normalizedRoute);
    mergeEmbeddedQuery(url.searchParams, embeddedQuery);
    mergeSearchParams(url.searchParams, searchParams);
    url.hash = "";
    return url.toString();
  }

  const url = new URL(baseUrl, "http://eve.local");
  const basePath = trimTrailingSlash(url.pathname);
  mergeEmbeddedQuery(url.searchParams, embeddedQuery);
  mergeSearchParams(url.searchParams, searchParams);
  return `${joinEveRoutePath(basePath, normalizedRoute)}${formatSearch(url.searchParams)}`;
}

function mergeEmbeddedQuery(target: URLSearchParams, embeddedQuery: string): void {
  if (embeddedQuery.length === 0) return;

  for (const [name, value] of new URLSearchParams(embeddedQuery)) {
    target.append(name, value);
  }
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
