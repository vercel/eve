/** Delivers an authorization attempt to the session that issued it. */

import { createHash } from "node:crypto";
import { dispatchSessionCommand } from "#execution/session/ingress.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { buildAuthorizationCompletePage } from "#runtime/connections/authorization-complete-page.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";

export async function handleConnectionCallbackRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const name = ctx.params.name;
  const attemptId = ctx.params.attemptId;
  const sessionId = ctx.params.sessionId;
  if (typeof name !== "string" || name.length === 0) {
    return Response.json({ error: "Missing connection name.", ok: false }, { status: 400 });
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return Response.json({ error: "Missing session ID.", ok: false }, { status: 400 });
  }
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return Response.json(
      { error: "Missing authorization attempt ID.", ok: false },
      { status: 400 },
    );
  }

  const callback = await projectAuthorizationCallback(request);

  try {
    const authorizationCallback = { attemptId, callback, connectionName: name };
    const eventId = createHash("sha256")
      .update(JSON.stringify(authorizationCallback))
      .digest("base64url");
    await dispatchSessionCommand(
      sessionId,
      {
        kind: "send",
        payload: { authorizationCallback },
      },
      `authorization:${eventId}`,
    );
  } catch {
    return Response.json({ error: "Connection callback not pending.", ok: false }, { status: 404 });
  }

  return buildAuthorizationCompletePage();
}

/**
 * Parses the live callback `Request` into the JSON-serializable
 * {@link AuthorizationCallback} handed to `completeAuthorization`.
 *
 * Only the IdP-returned params (query string, plus a form-encoded body
 * for `form_post` response modes) and the method are captured. Request
 * headers — including any inbound `Cookie`/`Authorization` — are
 * deliberately dropped so they never cross a step boundary; no shipped
 * strategy reads them.
 */
async function projectAuthorizationCallback(request: Request): Promise<AuthorizationCallback> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    params[key] = value;
  }

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await request.text();
    } catch {
      body = undefined;
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (body && contentType.includes("application/x-www-form-urlencoded")) {
      for (const [key, value] of new URLSearchParams(body)) {
        params[key] = value;
      }
    }
  }

  if (body !== undefined) {
    return { params, method: request.method, body };
  }
  return { params, method: request.method };
}
