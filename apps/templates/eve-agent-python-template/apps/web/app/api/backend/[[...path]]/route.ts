import type { NextRequest } from "next/server";
import { backendUrl } from "@/lib/backend";

/**
 * Browser-facing proxy to the private FastAPI service: `/api/backend/<path>`
 * forwards to `<BACKEND_URL>/<path>`. The `proxy.ts` gate runs first, so only
 * authenticated users reach it. Server Components can call `backendJson()`
 * directly instead.
 */
type Context = { params: Promise<{ path?: string[] }> };

async function forward(request: NextRequest, { params }: Context): Promise<Response> {
  const { path = [] } = await params;
  const url = backendUrl(path.map(encodeURIComponent).join("/"));
  url.search = request.nextUrl.search;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(url, {
    method: request.method,
    headers: {
      accept: request.headers.get("accept") ?? "application/json",
      ...(hasBody ? { "content-type": request.headers.get("content-type") ?? "application/json" } : {}),
    },
    body: hasBody ? await request.arrayBuffer() : undefined,
    cache: "no-store",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
