import { isSignInCallbackToken } from "#execution/callback-hook-tokens.js";
import { deliverToHostedHook } from "#execution/hosts.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { resumeRunnableHook } from "#execution/session-inbox/owner.js";

import type { RouteContext } from "#public/definitions/channel.js";
import { buildAuthorizationCompletePage } from "#runtime/connections/authorization-complete-page.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";

export async function handleConnectionCallbackRequest(
  request: Request,
  ctx: RouteContext,
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
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return Response.json(
      { error: "Missing authorization attempt ID.", ok: false },
      { status: 400 },
    );
  }

  if (!isSignInCallbackToken(token)) return callbackNotPending();

  const callback = await projectAuthorizationCallback(request);

  const payload: AuthorizationCallbackPayload = {
    kind: "authorization-callback",
    payloads: [{ authorizationCallback: { attemptId, callback, connectionName: name } }],
  };
  try {
    if (!(await deliverToHostedHook(token, payload))) await resumeRunnableHook(token, payload);
  } catch {
    return callbackNotPending();
  }

  return buildAuthorizationCompletePage(
    callback.params.error === undefined ? "authorized" : "failed",
  );
}

function callbackNotPending(): Response {
  return Response.json({ error: "Connection callback not pending.", ok: false }, { status: 404 });
}

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
