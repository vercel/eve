import { joinEveRoutePath } from "#shared/eve-route-path.js";

export function createRemoteAgentRouteUrl(baseUrl: string, routePath: string): string {
  const route = new URL(routePath, "http://eve.local");
  const url = new URL(baseUrl);
  url.pathname = joinEveRoutePath(url.pathname, route.pathname);
  url.search = route.search;
  url.hash = route.hash;
  return url.toString();
}
