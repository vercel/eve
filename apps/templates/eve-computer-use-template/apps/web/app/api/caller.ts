/**
 * Checks shared by the app's own API routes, which run beside the agent rather than behind its
 * channel auth in agent/channels/eve.ts.
 */

/**
 * Whether a request comes from this app's own pages. Browsers always send `Origin` on a WebSocket
 * and a cross-site `fetch`, so a page on another site can't use a session ID it learned to watch
 * or drive a sandbox. A request without `Origin`, from a server or a CLI, passes here and still
 * needs the eve session's auth.
 *
 * In development `vercel dev` rewrites a WebSocket's `Host` to Next.js's own port, so a page on
 * this machine is matched instead, as eve's `localDev()` does. `pnpm dev:all` binds `vercel dev`
 * to 127.0.0.1, so no other machine reaches these routes.
 */
export function isSameOrigin(request: Request): boolean {
  const sent = request.headers.get("origin");
  if (sent === null) return true;
  let origin: URL;
  try {
    origin = new URL(sent);
  } catch {
    return false;
  }
  if (process.env.VERCEL_ENV === "development") return LOOPBACK.has(origin.hostname);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return host !== null && origin.host === host;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Who may call the app's own API routes that don't go through an eve session, like Auto mode's
 * /api/device. Like `placeholderAuth()` in agent/channels/eve.ts, it refuses every production
 * request until you replace it with the same auth provider as the agent's channel.
 */
export function authorize(_request: Request): boolean {
  return process.env.VERCEL_ENV !== "production";
}
