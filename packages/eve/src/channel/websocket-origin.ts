import type { WebSocketUpgradeRequest } from "#channel/routes.js";

/**
 * Options for {@link validateWebSocketOrigin}.
 */
export interface ValidateWebSocketOriginOptions {
  /**
   * Origins permitted to open the WebSocket. Each entry is compared by its
   * normalized {@link URL.origin} (scheme + host + non-default port), so
   * `"https://app.example.com"`, `"https://app.example.com:443/"`, and
   * `"https://App.Example.com"` are equivalent. An empty list rejects every
   * origin.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Whether to allow handshakes that send no `Origin` header. A browser always
   * sends `Origin` on a WebSocket handshake, so a missing header marks a
   * non-browser client (native app, server-to-server) that cannot be the
   * target of cross-site WebSocket hijacking. Defaults to `false` (reject) —
   * the strict posture; set `true` when the route also serves non-browser
   * clients. The opaque `Origin: null` value is always rejected.
   */
  readonly allowNoOrigin?: boolean;
}

/**
 * Enforces an `Origin` allowlist on a WebSocket upgrade to defend against
 * cross-site WebSocket hijacking (CWE-1385) and DNS rebinding (CWE-346).
 *
 * Call it from a {@link WS} route's `upgrade` hook: it returns a `403`
 * `Response` to reject a handshake whose `Origin` is missing, opaque, or not
 * allowlisted, and `undefined` to let an allowed handshake proceed — matching
 * the hook's `Response | void` contract.
 *
 * An `Origin` check bounds the *browser* threat only: a browser cannot suppress
 * or forge the `Origin` header, but a non-browser client can send any value, so
 * this is one layer of defense, not authentication. Keep authenticating the
 * session as well.
 *
 * @example
 * ```ts
 * WS("/ws", () => ({
 *   upgrade(request) {
 *     return validateWebSocketOrigin(request, {
 *       allowedOrigins: ["https://app.example.com"],
 *     });
 *   },
 *   message(peer, message) {
 *     // ...
 *   },
 * }));
 * ```
 */
export function validateWebSocketOrigin(
  request: WebSocketUpgradeRequest,
  options: ValidateWebSocketOriginOptions,
): Response | undefined {
  const header = request.headers.get("origin");

  if (header === null || header === "") {
    return options.allowNoOrigin === true ? undefined : rejectUpgrade();
  }

  const origin = normalizeOrigin(header);

  if (origin === null) {
    return rejectUpgrade();
  }

  for (const candidate of options.allowedOrigins) {
    if (normalizeOrigin(candidate) === origin) {
      return undefined;
    }
  }

  return rejectUpgrade();
}

function rejectUpgrade(): Response {
  return Response.json(
    { error: "WebSocket upgrade rejected: Origin is not allowed.", ok: false },
    { status: 403 },
  );
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
