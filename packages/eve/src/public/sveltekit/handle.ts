import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath, normalizePublicEveRoutePath } from "#shared/eve-route-path.js";

import { resolveProductionOrigin } from "./production-origin.js";

/**
 * Subset of a SvelteKit `RequestEvent` the eve hook reads. Kept structural so
 * the hook stays assignable to SvelteKit's `Handle` without eve depending on
 * SvelteKit types.
 */
export interface EveSvelteKitHandleEvent {
  readonly request: Request;
  readonly url: URL;
}

export interface EveSvelteKitHandleInput<TEvent extends EveSvelteKitHandleEvent> {
  readonly event: TEvent;
  readonly resolve: (event: TEvent) => Response | Promise<Response>;
}

export interface EveSvelteKitHandleOptions {
  /**
   * Origin hosting eve under its public paths (`/eve/v1` or
   * `/eve/<name>/v1`). Defaults to `EVE_SVELTEKIT_PRODUCTION_ORIGIN`, then to
   * `http://127.0.0.1:${EVE_SVELTEKIT_PRODUCTION_PORT ?? 4274}`.
   * Ignored when `agents` is set.
   */
  readonly origin?: string;
  /**
   * Named agent servers for an `agents/` workspace. Each server serves
   * `/eve/v1`; the hook mounts it at `/eve/<name>/v1`. Only these agents are
   * forwarded when set. No agent files are needed in the deployed frontend.
   * Omit this when `origin` hosts all agents under their public paths.
   */
  readonly agents?: Readonly<Record<string, string>>;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function resolveTarget(pathname: string, options: EveSvelteKitHandleOptions): URL | undefined {
  if (options.agents !== undefined) {
    for (const [name, origin] of Object.entries(options.agents)) {
      const prefix = joinEveRoutePath(`/eve/${name}`, EVE_ROUTE_PREFIX);
      if (matchesPrefix(pathname, prefix)) {
        return new URL(`${EVE_ROUTE_PREFIX}${pathname.slice(prefix.length)}`, origin);
      }
    }
    return undefined;
  }
  if (matchesPrefix(normalizePublicEveRoutePath(pathname), EVE_ROUTE_PREFIX)) {
    return new URL(pathname, options.origin ?? resolveProductionOrigin());
  }
  return undefined;
}

function createProxyHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  return headers;
}

function createForwardedRequest(request: Request, target: URL): Request {
  const headers = createProxyHeaders(request.headers);
  // The eve service answers on its own origin; a stale Host breaks its
  // absolute URL construction and any host-based routing in front of it.
  headers.delete("host");

  return new Request(target, {
    body: request.body,
    // Streaming request bodies need the half-duplex opt-in under Node.
    duplex: "half",
    headers,
    method: request.method,
    redirect: "manual",
    signal: request.signal,
  } as RequestInit & { duplex: "half" });
}

/**
 * SvelteKit `handle` hook that forwards eve transport requests (`/eve/v1/**`
 * or `/eve/<name>/v1/**`) from the app's origin in production.
 * Start and manage the upstream eve servers separately.
 *
 * Use it when the SvelteKit app does not deploy to Vercel, where eve routes
 * are served by a sibling Vercel service instead. In development the Vite
 * plugin proxies the same routes before SvelteKit sees them.
 *
 * ```ts
 * // src/hooks.server.ts
 * import { createEveHandle } from "eve/sveltekit";
 *
 * export const handle = createEveHandle();
 * ```
 */
export function createEveHandle(options: EveSvelteKitHandleOptions = {}) {
  return async <TEvent extends EveSvelteKitHandleEvent>(
    input: EveSvelteKitHandleInput<TEvent>,
  ): Promise<Response> => {
    const target = resolveTarget(input.event.url.pathname, options);
    if (target === undefined) {
      return await input.resolve(input.event);
    }
    target.search = input.event.url.search;

    const upstream = await fetch(createForwardedRequest(input.event.request, target));
    const headers = createProxyHeaders(upstream.headers);
    // fetch decodes the body but retains the upstream's encoded representation headers.
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(upstream.body, {
      headers,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  };
}
