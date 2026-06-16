/**
 * Framework-shipped callback route used by in-turn interactive
 * connection authorization.
 *
 * The route at {@link EVE_CONNECTION_CALLBACK_ROUTE_PATTERN} is the
 * redirect target the workflow body hands to the IdP via
 * `startAuthorization`. When the IdP redirects the user's browser back
 * with the OAuth `code`/`state` (or whatever payload the protocol
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

import { resumeHook } from "#compiled/@workflow/core/runtime.js";

import { applyEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import { EVE_CONNECTION_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import type { ChannelMethod, RouteContext } from "#public/definitions/channel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { buildAuthorizationCompletePage } from "#runtime/connections/authorization-complete-page.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";

/**
 * Logical name prefix of the framework-shipped connection callback
 * channel. The trailing method segment (`get` or `post`) keeps each
 * `(method, urlPath)` pair distinct in the channel registry.
 */
export const HTTP_CONNECTION_CALLBACK_CHANNEL_NAME_PREFIX = "eve/v1/connections/callback";

/**
 * HTTP methods accepted by the connection callback route.
 *
 * Most OAuth IdPs redirect back over `GET` (authorization code in the
 * query string). Some `form_post` response modes deliver the callback
 * over `POST` instead, so the framework registers both. Both
 * methods route through the same handler.
 */
const HANDLED_METHODS: readonly ChannelMethod[] = ["GET", "POST"];

/**
 * Returns the framework-shipped channel definitions that mount the
 * connection callback route at {@link EVE_CONNECTION_CALLBACK_ROUTE_PATTERN}.
 *
 * Returns one definition per accepted HTTP method (see
 * {@link HANDLED_METHODS}). The framework channel resolver mounts each
 * `(method, urlPath)` pair as a separate Nitro route; sharing one URL
 * pattern across multiple methods is not supported by the channel
 * model.
 */
export function getConnectionCallbackChannelDefinitions(): readonly ResolvedChannelDefinition[] {
  return HANDLED_METHODS.map((method) => buildCallbackChannelDefinition(method));
}

/**
 * Returns the set of logical channel names registered by the connection
 * callback route. Used by `getAllFrameworkChannelNames` so authors who
 * `disableRoute()` one of these names get a useful diagnostic instead
 * of a silent no-op.
 */
export function getConnectionCallbackChannelNames(): ReadonlySet<string> {
  return new Set(HANDLED_METHODS.map(channelNameForMethod));
}

function buildCallbackChannelDefinition(method: ChannelMethod): ResolvedChannelDefinition {
  const name = channelNameForMethod(method);
  return {
    name,
    method,
    urlPath: EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
    fetch: handleConnectionCallbackRequest,
    logicalPath: `framework://channels/${name}`,
    sourceId: `eve:framework:connection-callback-${method.toLowerCase()}`,
    sourceKind: "module",
  };
}

function channelNameForMethod(method: ChannelMethod): string {
  return `${HTTP_CONNECTION_CALLBACK_CHANNEL_NAME_PREFIX}/${method.toLowerCase()}`;
}

/**
 * Inbound handler for the connection callback route. Exported for test
 * coverage; the framework channel resolver wires it into Nitro via
 * {@link getConnectionCallbackChannelDefinitions}.
 */
export async function handleConnectionCallbackRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const name = ctx.params.name;
  const token = ctx.params.token;
  if (typeof name !== "string" || name.length === 0) {
    return Response.json({ error: "Missing connection name.", ok: false }, { status: 400 });
  }
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing callback token.", ok: false }, { status: 400 });
  }

  const callback = await projectAuthorizationCallback(request);

  // Deliver the callback through the per-session auth hook token
  // embedded in the URL by getHookUrl(). The workflow body creates
  // this hook upfront (before any turns run) so it always exists
  // when the callback arrives.
  try {
    applyEveWorkflowQueueNamespace();
    await resumeHook(token, {
      kind: "deliver" as const,
      payloads: [{ authorizationCallback: { connectionName: name, callback } }],
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
