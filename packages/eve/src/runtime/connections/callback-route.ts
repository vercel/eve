/**
 * Framework-shipped callback route used by in-turn interactive
 * connection authorization.
 *
 * The eve connection callback route is the redirect target the workflow body
 * hands to the IdP via `startAuthorization`. When the IdP redirects the user's
 * browser back with the OAuth `code`/`state` (or whatever payload the protocol
 * carries), this handler:
 *
 * 1. Parses the inbound request into a JSON-serializable
 *    {@link AuthorizationCallback} (params only — never request headers).
 * 2. Calls `resumeHook(token, payload)` to wake the suspended workflow.
 * 3. Renders the standard "Authorization complete" landing page so the
 *    user sees a friendly UI instead of an empty `202 Accepted`.
 *
 * Owning this route in the framework - instead of routing the IdP at the
 * workflow runtime's raw `/.well-known/workflow/v1/webhook/:token` -
 * keeps the public surface namespaced under eve and lets the framework
 * decide delivery policy (auth, throttling, logging) for connection
 * callbacks without leaking generic workflow primitives to the public
 * internet.
 */

import { resumeHook } from "#internal/workflow/runtime.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { buildAuthorizationCompletePage } from "#runtime/connections/authorization-complete-page.js";
import type { AuthorizationCallback } from "#shared/connections.js";

/**
 * Inbound handler shared by the ordinary framework channel modules for the
 * GET and POST connection callback routes.
 */
export async function handleConnectionCallbackRequest(
  request: Request,
  ctx: Pick<RouteHandlerArgs, "params">,
): Promise<Response> {
  return handleCallbackRequest(request, ctx, false);
}

export async function handleLegacyConnectionCallbackRequest(
  request: Request,
  ctx: Pick<RouteHandlerArgs, "params">,
): Promise<Response> {
  return handleCallbackRequest(request, ctx, true);
}

async function handleCallbackRequest(
  request: Request,
  ctx: Pick<RouteHandlerArgs, "params">,
  legacy: boolean,
): Promise<Response> {
  const name = ctx.params.name;
  const attemptId = ctx.params.attemptId;
  const token = ctx.params.token;
  if (typeof name !== "string" || name.length === 0) {
    return Response.json({ error: "Missing connection name.", ok: false }, { status: 400 });
  }
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing callback token.", ok: false }, { status: 400 });
  }
  if (!legacy && (typeof attemptId !== "string" || attemptId.length === 0)) {
    return Response.json(
      { error: "Missing authorization attempt ID.", ok: false },
      { status: 400 },
    );
  }

  const callback = await projectAuthorizationCallback(request);

  // Deliver the callback through the per-session auth hook token
  // embedded in the URL by getHookUrl(). The workflow body creates
  // this hook upfront (before any turns run) so it always exists
  // when the callback arrives.
  try {
    const authorizationCallback = legacy
      ? { callback, connectionName: name, legacy: true as const }
      : { attemptId: attemptId!, callback, connectionName: name };
    await resumeHook(token, {
      kind: "deliver" as const,
      payloads: [{ authorizationCallback }],
    });
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
