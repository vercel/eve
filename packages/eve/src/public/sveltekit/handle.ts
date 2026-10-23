import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

import { resolveProductionOrigin } from "./routing.js";

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
   * Origin the eve service listens on. Defaults to
   * `EVE_SVELTEKIT_PRODUCTION_ORIGIN`, then to
   * `http://127.0.0.1:${EVE_SVELTEKIT_PRODUCTION_PORT ?? 4274}`.
   */
  readonly origin?: string;
}

function isEveRoute(pathname: string): boolean {
  return pathname === EVE_ROUTE_PREFIX || pathname.startsWith(`${EVE_ROUTE_PREFIX}/`);
}

function createForwardedRequest(request: Request, target: URL): Request {
  const headers = new Headers(request.headers);
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
 * SvelteKit `handle` hook that serves eve transport requests (`/eve/v1/**`)
 * from the same origin as the app in production.
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
    if (!isEveRoute(input.event.url.pathname)) {
      return await input.resolve(input.event);
    }

    const target = new URL(
      `${input.event.url.pathname}${input.event.url.search}`,
      options.origin ?? resolveProductionOrigin(),
    );

    return await fetch(createForwardedRequest(input.event.request, target));
  };
}
