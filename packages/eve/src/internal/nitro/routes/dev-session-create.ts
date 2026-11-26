import { sessionAuthFromResult } from "#channel/auth/result.js";
import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { parseOptionalJsonRequest, rejectUnknownFields } from "#eve-channel/request.js";
import { getEveChannelAuth } from "#eve-channel/support.js";
import type { EveAuthResult } from "#eve-channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  resolveAcceptedDeploymentId,
  withDevelopmentVercelOidcContext,
} from "#internal/nitro/routes/channel-dispatch.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/session-http.js";
import { localDev, routeAuth } from "#public/channels/auth.js";
import {
  InvalidSessionHistoryError,
  type SessionHistoryMessage,
  validateSessionHistory,
} from "#shared/session-history.js";
import { parseToolStubs } from "#tool-stubs/rules.js";
import type { ToolStub } from "#tool-stubs/types.js";
import { InvalidToolStubTargetError } from "#tool-stubs/validate-targets.js";

const log = createLogger("dev.session-create");
const localDevelopmentCaller = localDev();

export const MAX_DEV_SESSION_HISTORY_MESSAGES = 500;
export const MAX_DEV_SESSION_HISTORY_BYTES = 512 * 1024;

interface ParsedDevSessionBody {
  readonly history: readonly SessionHistoryMessage[];
  readonly stubs?: readonly ToolStub[];
}

export async function handleDevSessionCreateRequest(
  config: NitroArtifactsConfig,
  request: Request,
): Promise<Response> {
  if (config.kind !== "development") {
    return Response.json({ error: "Not found.", ok: false }, { status: 404 });
  }

  const localCaller = await localDevelopmentCaller(request);
  if (!localCaller) {
    return Response.json(
      { error: "Dev session creation is only available to local development callers.", ok: false },
      { status: 403 },
    );
  }

  const bundle = await resolveNitroChannelRuntimeBundle(config);
  const eveRoute =
    bundle.channels.find(
      (channel) =>
        channel.method.toUpperCase() === "POST" && channel.urlPath === EVE_SESSION_ROUTE_PATH,
    ) ?? bundle.channels.find((channel) => channel.name === "eve");
  const eveAuth = getEveChannelAuth(eveRoute?.definition);

  let authResult: EveAuthResult | Response;
  if (eveAuth === undefined) {
    authResult = localCaller;
  } else {
    try {
      authResult = await withDevelopmentVercelOidcContext(
        config,
        request,
        async () => await routeAuth(request, eveAuth),
      );
    } catch (error) {
      const errorId = logError(log, "dev session-create auth failed", error);
      return Response.json(
        { error: "Authentication failed.", errorId, ok: false },
        { status: 500 },
      );
    }
  }
  if (authResult instanceof Response) return authResult;
  const auth = sessionAuthFromResult(authResult);

  const payload = await parseOptionalJsonRequest(request);
  if (payload instanceof Response) return payload;
  if (payload.stubs !== undefined && authResult.allowToolStubs !== true) {
    return Response.json(
      { error: "Tool stubbing is not permitted for this caller.", ok: false },
      { status: 403 },
    );
  }

  const body = parseDevSessionBody(payload);
  if (body instanceof Response) return body;

  const adapter = eveRoute?.adapter ?? { kind: "channel" };
  const channelName = eveRoute?.name ?? "eve";
  const channelKind =
    (eveRoute === undefined ? undefined : getChannelInstrumentationKind(eveRoute.definition)) ??
    adapter.kind;
  const requestId = readVercelRequestId(request.headers);
  const delivery = createChannelDeliveryMetadata({
    acceptedDeploymentId: await resolveAcceptedDeploymentId(config),
    channelKind,
    channelName,
    requestId,
  });

  try {
    const handle = await bundle.runtime.createSession({
      adapter,
      audienceAuth: auth,
      auth,
      capabilities: { requestInput: true },
      channelName,
      delivery,
      input: { history: body.history },
      requestId,
      ...(body.stubs !== undefined && {
        toolStubs: { rules: body.stubs, token: crypto.randomUUID() },
      }),
    });

    return Response.json(
      { ok: true, sessionId: handle.sessionId },
      {
        headers: {
          "cache-control": "no-store",
          [EVE_SESSION_ID_HEADER]: handle.sessionId,
        },
        status: 202,
      },
    );
  } catch (error) {
    if (error instanceof InvalidToolStubTargetError) {
      return Response.json({ error: error.message, ok: false }, { status: 400 });
    }
    const errorId = logError(log, "dev session-create request failed", error);
    return Response.json(
      { error: "Failed to create the session.", errorId, ok: false },
      { status: 500 },
    );
  }
}

function parseDevSessionBody(payload: Record<string, unknown>): ParsedDevSessionBody | Response {
  const unknown = rejectUnknownFields(payload, ["history", "stubs"]);
  if (unknown !== undefined) return unknown;

  if (payload.history === undefined) {
    return Response.json(
      { error: "history must be an array of messages.", ok: false },
      { status: 400 },
    );
  }
  if (Array.isArray(payload.history) && payload.history.length > MAX_DEV_SESSION_HISTORY_MESSAGES) {
    return Response.json(
      {
        error: `history exceeds the maximum of ${String(MAX_DEV_SESSION_HISTORY_MESSAGES)} messages.`,
        ok: false,
      },
      { status: 400 },
    );
  }
  let history: readonly SessionHistoryMessage[];
  try {
    const validated = validateSessionHistory(payload.history);
    if (validated === undefined) {
      return Response.json(
        { error: "history must be an array of messages.", ok: false },
        { status: 400 },
      );
    }
    history = validated;
  } catch (error) {
    if (!(error instanceof InvalidSessionHistoryError)) throw error;
    return Response.json({ error: error.message, ok: false }, { status: 400 });
  }
  if (historyByteLength(history) > MAX_DEV_SESSION_HISTORY_BYTES) {
    return Response.json(
      {
        error: `history exceeds the maximum size of ${String(MAX_DEV_SESSION_HISTORY_BYTES / 1024)} KiB.`,
        ok: false,
      },
      { status: 400 },
    );
  }

  let stubs: readonly ToolStub[] | undefined;
  if (payload.stubs !== undefined) {
    try {
      stubs = parseToolStubs(payload.stubs);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid tool stubs.", ok: false },
        { status: 400 },
      );
    }
  }

  return { history, stubs };
}

function historyByteLength(history: readonly SessionHistoryMessage[]): number {
  let bytes = 0;
  for (const entry of history) {
    bytes += Buffer.byteLength(entry.text, "utf8");
    if (entry.id !== undefined) bytes += Buffer.byteLength(entry.id, "utf8");
  }
  return bytes;
}

function readVercelRequestId(headers: Headers): string | undefined {
  const requestId = headers.get("x-vercel-id")?.trim();
  return requestId === "" ? undefined : requestId;
}
