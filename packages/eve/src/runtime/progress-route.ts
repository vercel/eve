import { resumeHook } from "#internal/workflow/runtime.js";

import { parseProgressBatchV1 } from "#protocol/progress.js";
import { EVE_PROGRESS_ROUTE_PATTERN } from "#protocol/routes.js";
import type { ChannelMethod, RouteContext } from "#public/definitions/channel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

export const HTTP_PROGRESS_CHANNEL_NAME_PREFIX = "eve/v1/progress";
const MAX_PROGRESS_REQUEST_BYTES = 128 * 1024;
const HANDLED_METHODS: readonly ChannelMethod[] = ["POST"];

export function getProgressChannelDefinitions(): readonly ResolvedChannelDefinition[] {
  return HANDLED_METHODS.map((method) => ({
    name: channelNameForMethod(method),
    method,
    urlPath: EVE_PROGRESS_ROUTE_PATTERN,
    fetch: handleProgressRequest,
    logicalPath: `framework://channels/${channelNameForMethod(method)}`,
    sourceId: `eve:framework:progress-${method.toLowerCase()}`,
    sourceKind: "module",
  }));
}

export function getProgressChannelNames(): ReadonlySet<string> {
  return new Set(HANDLED_METHODS.map(channelNameForMethod));
}

export async function handleProgressRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const token = ctx.params.token;
  if (typeof token !== "string" || token.length < 32 || token.length > 500) {
    return Response.json({ error: "Invalid progress callback.", ok: false }, { status: 400 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Progress callbacks require JSON.", ok: false }, { status: 400 });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROGRESS_REQUEST_BYTES) {
    return Response.json(
      { error: "Progress callback body is too large.", ok: false },
      { status: 400 },
    );
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: "Invalid progress callback body.", ok: false }, { status: 400 });
  }
  if (new TextEncoder().encode(text).byteLength > MAX_PROGRESS_REQUEST_BYTES) {
    return Response.json(
      { error: "Progress callback body is too large.", ok: false },
      { status: 400 },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  const batch = parseProgressBatchV1(value);
  if (batch === undefined) {
    return Response.json({ error: "Invalid progress batch.", ok: false }, { status: 400 });
  }
  try {
    await resumeHook(token, batch);
  } catch {
    return Response.json({ error: "Progress collector not found.", ok: false }, { status: 404 });
  }
  return Response.json({ ok: true }, { status: 202 });
}

function channelNameForMethod(method: ChannelMethod): string {
  return `${HTTP_PROGRESS_CHANNEL_NAME_PREFIX}/${method.toLowerCase()}`;
}
