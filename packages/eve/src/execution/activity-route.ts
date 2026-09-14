import { resumeHook } from "#internal/workflow/runtime.js";

import { parseActivityBatchV1 } from "#protocol/activity.js";
import type { RouteContext } from "#public/definitions/channel.js";

const MAX_ACTIVITY_REQUEST_BYTES = 128 * 1024;

export async function handleActivityRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const token = ctx.params.token;
  if (typeof token !== "string" || token.length < 32 || token.length > 500) {
    return Response.json({ error: "Invalid activity sink.", ok: false }, { status: 400 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Activity sinks require JSON.", ok: false }, { status: 400 });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACTIVITY_REQUEST_BYTES) {
    return Response.json({ error: "Activity sink body is too large.", ok: false }, { status: 400 });
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: "Invalid activity sink body.", ok: false }, { status: 400 });
  }
  if (new TextEncoder().encode(text).byteLength > MAX_ACTIVITY_REQUEST_BYTES) {
    return Response.json({ error: "Activity sink body is too large.", ok: false }, { status: 400 });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  const batch = parseActivityBatchV1(value);
  if (batch === undefined) {
    return Response.json({ error: "Invalid activity batch.", ok: false }, { status: 400 });
  }
  try {
    await resumeHook(token, batch);
  } catch {
    return Response.json({ error: "Activity collector not found.", ok: false }, { status: 404 });
  }
  return Response.json({ ok: true }, { status: 202 });
}
