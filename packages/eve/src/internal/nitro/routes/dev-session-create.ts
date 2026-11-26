import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { parseOptionalJsonRequest, rejectUnknownFields } from "#eve-channel/request.js";
import { createLogger, logError } from "#internal/logging.js";
import { resolveAcceptedDeploymentId } from "#internal/nitro/routes/channel-dispatch.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/session-http.js";
import { localDev } from "#public/channels/auth.js";
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
export const MAX_DEV_SESSION_HISTORY_NODES = 20_000;
export const MAX_DEV_SESSION_HISTORY_DEPTH = 32;

interface ParsedDevSessionBody {
  readonly history?: readonly SessionHistoryMessage[];
  readonly stubs?: readonly ToolStub[];
}

export async function handleDevSessionCreateRequest(
  config: NitroArtifactsConfig,
  request: Request,
): Promise<Response> {
  if (config.kind !== "development") {
    return Response.json({ error: "Not found.", ok: false }, { status: 404 });
  }

  const caller = await localDevelopmentCaller(request);
  if (!caller) {
    return Response.json(
      { error: "Dev session creation is only available to local development callers.", ok: false },
      { status: 403 },
    );
  }

  const payload = await parseOptionalJsonRequest(request);
  if (payload instanceof Response) return payload;

  const body = parseDevSessionBody(payload);
  if (body instanceof Response) return body;

  const bundle = await resolveNitroChannelRuntimeBundle(config);
  const eveRoute =
    bundle.channels.find(
      (channel) =>
        channel.method.toUpperCase() === "POST" && channel.urlPath === EVE_SESSION_ROUTE_PATH,
    ) ?? bundle.channels.find((channel) => channel.name === "eve");
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
      audienceAuth: caller,
      auth: caller,
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

  let history: readonly SessionHistoryMessage[] | undefined;
  if (payload.history !== undefined) {
    const boundError = checkDevSessionHistoryBounds(payload.history);
    if (boundError !== undefined) {
      return Response.json({ error: boundError, ok: false }, { status: 400 });
    }
    try {
      history = validateSessionHistory(payload.history);
    } catch (error) {
      if (!(error instanceof InvalidSessionHistoryError)) throw error;
      return Response.json({ error: error.message, ok: false }, { status: 400 });
    }
    if (
      history !== undefined &&
      Buffer.byteLength(JSON.stringify(history), "utf8") > MAX_DEV_SESSION_HISTORY_BYTES
    ) {
      return Response.json(
        {
          error: `history exceeds the maximum size of ${String(MAX_DEV_SESSION_HISTORY_BYTES / 1024)} KiB.`,
          ok: false,
        },
        { status: 400 },
      );
    }
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

function checkDevSessionHistoryBounds(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > MAX_DEV_SESSION_HISTORY_MESSAGES) {
    return `history exceeds the maximum of ${String(MAX_DEV_SESSION_HISTORY_MESSAGES)} messages.`;
  }
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value }];
  let nodes = 0;
  let size = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++nodes > MAX_DEV_SESSION_HISTORY_NODES || entry.depth > MAX_DEV_SESSION_HISTORY_DEPTH) {
      return "history exceeds the nesting or complexity limit.";
    }
    if (typeof entry.value === "string") {
      size += Buffer.byteLength(entry.value, "utf8");
    } else if (entry.value !== null && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value)) {
        if (key === "__proto__") {
          return "history cannot contain prototype keys.";
        }
        size += Buffer.byteLength(key, "utf8");
        pending.push({ depth: entry.depth + 1, value: child });
      }
    }
    if (size > MAX_DEV_SESSION_HISTORY_BYTES) {
      return `history exceeds the maximum size of ${String(MAX_DEV_SESSION_HISTORY_BYTES / 1024)} KiB.`;
    }
  }
  return undefined;
}

function readVercelRequestId(headers: Headers): string | undefined {
  const requestId = headers.get("x-vercel-id")?.trim();
  return requestId === "" ? undefined : requestId;
}
