import { type H3Event, HTTPError } from "nitro";

export function rejectHeadRequest(event: H3Event, allow: string): void {
  const method = event.req.method;
  if (method !== "HEAD") return;
  const headers = new Headers(event.res.errHeaders);
  headers.set("allow", allow);
  throw new HTTPError({
    headers,
    message: `Method ${method} is not allowed for ${event.url.pathname} (allowed: ${allow})`,
    status: 405,
    statusText: "Method Not Allowed",
  });
}
