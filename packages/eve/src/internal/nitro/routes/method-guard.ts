import { type H3Event, HTTPError } from "nitro";

/**
 * Rejects HEAD on a path that declares GET but no HEAD route, before the route
 * does any work, with the same 405 Nitro sends for an undeclared method.
 */
export function rejectHeadRequest(event: H3Event, allow: string): void {
  const method = event.req.method;
  if (method !== "HEAD") return;
  throw new HTTPError({
    headers: { allow },
    message: `Method ${method} is not allowed for ${event.url.pathname} (allowed: ${allow})`,
    status: 405,
    statusText: "Method Not Allowed",
  });
}
