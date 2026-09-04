import type { FilePart, TextPart, UserContent } from "ai";

import type {
  ActivityObserverConfig,
  SessionAuthContext,
  SessionCallback,
  SessionCapabilities,
  TurnPolicy,
} from "#channel/types.js";
import type { Session } from "#channel/session.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import {
  parseActivityObserverField,
  validateActivityObserverBinding,
} from "#eve-channel/activity-observer-request.js";
import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_MESSAGE_STREAM_FORMAT,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import {
  collectUploadPolicyViolations,
  formatUploadPolicyViolation,
  type UploadPolicy,
} from "#public/channels/upload-policy.js";
import { isInputResponse, type ValidatedInputResponse } from "#shared/input.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";

interface ParsedCreateBody {
  activityObserver?: ActivityObserverConfig;
  callback?: SessionCallback;
  capabilities?: SessionCapabilities;
  message: string | UserContent;
  mode?: RunMode;
  context?: readonly string[];
  operationId?: string;
  outputSchema?: JsonObject;
}

/** Replay-stable identity for one authenticated create operation. */
export async function deriveOperationContinuationToken(input: {
  readonly auth: SessionAuthContext;
  readonly operationId: string;
}): Promise<string> {
  const identity = JSON.stringify([
    "eve:create-session:v1",
    input.auth.authenticator,
    input.auth.issuer ?? null,
    input.auth.principalType,
    input.auth.principalId,
    input.operationId,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `eve:op:${hex.slice(0, 32)}`;
}

export function parseCreateBody(payload: Record<string, unknown>): ParsedCreateBody | Response {
  if (payload.inputResponses !== undefined) {
    return Response.json(
      { error: "'inputResponses' is only accepted for an existing session.", ok: false },
      { status: 400 },
    );
  }
  const message = parseMessageField(payload.message);
  if (message instanceof Response) return message;

  const context = parseClientContextField(payload.clientContext);
  if (context instanceof Response) return context;

  const callback = parseCallbackField(payload.callback);
  if (callback instanceof Response) return callback;

  const capabilities = parseCapabilitiesField(payload.capabilities);
  if (capabilities instanceof Response) return capabilities;

  const activityObserver = parseActivityObserverField(payload.activityObserver);
  if (activityObserver instanceof Response) return activityObserver;
  if (activityObserver !== undefined) {
    const observerRejection = validateActivityObserverBinding(activityObserver, callback);
    if (observerRejection !== undefined) return observerRejection;
  }

  const mode = parseModeField(payload.mode);
  if (mode instanceof Response) return mode;

  const outputSchema = parseOutputSchemaField(payload.outputSchema);
  if (outputSchema instanceof Response) return outputSchema;

  if (message === undefined) {
    return Response.json(
      { error: "Missing or empty 'message' field.", ok: false },
      { status: 400 },
    );
  }

  const rawOperationId = payload.operationId;
  if (rawOperationId !== undefined && (typeof rawOperationId !== "string" || !rawOperationId)) {
    return Response.json(
      { error: "Expected 'operationId' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }

  const result: ParsedCreateBody = {
    activityObserver,
    callback,
    capabilities,
    message,
    mode,
    context,
    outputSchema,
  };
  if (typeof rawOperationId === "string") result.operationId = rawOperationId;
  return result;
}

interface ParsedSessionMessageBody {
  activityObserver?: ActivityObserverConfig;
  callback?: SessionCallback;
  message?: string | UserContent;
  inputResponses?: readonly ValidatedInputResponse[];
  context?: readonly string[];
  outputSchema?: JsonObject;
  turnPolicy?: TurnPolicy;
}

export function parseSessionMessageBody(
  payload: Record<string, unknown>,
): ParsedSessionMessageBody | Response {
  const tokenRejection = rejectSessionContinuationToken(payload);
  if (tokenRejection !== null) return tokenRejection;

  const message = parseMessageField(payload.message);
  if (message instanceof Response) return message;
  const callback = parseCallbackField(payload.callback);
  if (callback instanceof Response) return callback;
  const activityObserver = parseActivityObserverField(payload.activityObserver);
  if (activityObserver instanceof Response) return activityObserver;
  if (activityObserver !== undefined) {
    const observerRejection = validateActivityObserverBinding(activityObserver, callback);
    if (observerRejection !== undefined) return observerRejection;
  }
  const inputResponses = parseInputResponses(payload.inputResponses);
  if (inputResponses instanceof Response) return inputResponses;
  const context = parseClientContextField(payload.clientContext);
  if (context instanceof Response) return context;
  const outputSchema = parseOutputSchemaField(payload.outputSchema);
  if (outputSchema instanceof Response) return outputSchema;
  const turnPolicy = parseTurnPolicyField(payload.turnPolicy);
  if (turnPolicy instanceof Response) return turnPolicy;

  if (message === undefined && inputResponses === undefined) {
    return Response.json(
      {
        error: "Expected a non-empty 'message' or a non-empty 'inputResponses' array.",
        ok: false,
      },
      { status: 400 },
    );
  }

  if (message !== undefined && inputResponses !== undefined) {
    return Response.json(
      { error: "'message' and 'inputResponses' are mutually exclusive.", ok: false },
      { status: 400 },
    );
  }

  return {
    activityObserver,
    callback,
    message,
    inputResponses,
    context,
    outputSchema,
    turnPolicy,
  };
}

interface ParsedCancelTurnBody {
  taskId?: string;
  turnId?: string;
}

export async function parseCancelTurnBody(req: Request): Promise<ParsedCancelTurnBody | Response> {
  const payload = await parseOptionalJsonRequest(req);
  if (payload instanceof Response) return payload;
  const tokenRejection = rejectSessionContinuationToken(payload);
  if (tokenRejection !== null) return tokenRejection;

  const turnId = payload.turnId;
  const taskId = payload.taskId;
  if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
    return Response.json(
      { error: "Expected 'turnId' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }
  if (taskId !== undefined && (typeof taskId !== "string" || taskId.length === 0)) {
    return Response.json(
      { error: "Expected 'taskId' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }
  const result: ParsedCancelTurnBody = {};
  if (typeof taskId === "string") result.taskId = taskId;
  if (typeof turnId === "string") result.turnId = turnId;
  return result;
}

export async function parseJsonRequest(req: Request): Promise<Record<string, unknown> | Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }
  return payload as Record<string, unknown>;
}

export async function parseResetBody(
  req: Request,
): Promise<{ readonly reason?: string } | Response> {
  const payload = await parseOptionalJsonRequest(req);
  if (payload instanceof Response) return payload;
  const tokenRejection = rejectSessionContinuationToken(payload);
  if (tokenRejection !== null) return tokenRejection;
  const reason = payload.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0)) {
    return Response.json(
      { error: "Expected 'reason' to be a non-empty string.", ok: false },
      { status: 400 },
    );
  }
  return reason === undefined ? {} : { reason };
}

export async function parseSessionControlBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  const payload = await parseOptionalJsonRequest(req);
  if (payload instanceof Response) return payload;
  return rejectSessionContinuationToken(payload) ?? payload;
}

async function parseOptionalJsonRequest(req: Request): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return Response.json({ error: "Unreadable request body.", ok: false }, { status: 400 });
  }
  if (text.trim().length === 0) return {};

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }
  return payload as Record<string, unknown>;
}

export function rejectSessionContinuationToken(payload: Record<string, unknown>): Response | null {
  return "continuationToken" in payload
    ? Response.json(
        { error: "Session-ID routes do not accept 'continuationToken'.", ok: false },
        { status: 400 },
      )
    : null;
}

export function requireSessionId(params: Readonly<Record<string, string>>): string | Response {
  const sessionId = params.sessionId;
  return sessionId || Response.json({ error: "Missing session id.", ok: false }, { status: 400 });
}

export async function createSessionStreamResponse(
  request: Request,
  session: Session,
): Promise<Response> {
  const startIndex = parseStartIndex(request);
  if (startIndex instanceof Response) return startIndex;
  const includeTailIndex = parseIncludeTailIndex(request);

  try {
    const tailIndex = includeTailIndex ? await session.getStreamTailIndex() : undefined;
    const events = await session.getEventStream({ startIndex });
    const headers = new Headers({
      "cache-control": "no-store, no-transform",
      "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE,
      "x-accel-buffering": "no",
      [EVE_SESSION_ID_HEADER]: session.id,
      [EVE_STREAM_FORMAT_HEADER]: EVE_MESSAGE_STREAM_FORMAT,
      [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
    });
    if (tailIndex !== undefined) {
      headers.set(EVE_STREAM_TAIL_INDEX_HEADER, String(tailIndex));
    }
    return new Response(
      serializeAsNdjson(events, request.signal, streamEventLimit(startIndex, tailIndex)),
      { headers },
    );
  } catch {
    return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
  }
}

function parseOutputSchemaField(value: unknown): JsonObject | Response | undefined {
  if (value === undefined) return undefined;

  try {
    return parseJsonObject(value);
  } catch {
    return Response.json(
      { error: "Expected 'outputSchema' to be a JSON-serializable object.", ok: false },
      { status: 400 },
    );
  }
}

function parseCallbackField(value: unknown): SessionCallback | Response | undefined {
  if (value === undefined) return undefined;
  const parsed = parseSessionCallback(value);
  if (parsed.ok) return parsed.callback;

  return Response.json({ error: parsed.message, ok: false }, { status: 400 });
}

function parseCapabilitiesField(value: unknown): SessionCapabilities | Response | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Response.json(
      { error: "Expected 'capabilities' to be an object.", ok: false },
      { status: 400 },
    );
  }

  const keys = Object.keys(value);
  const requestInput = Reflect.get(value, "requestInput");
  if (
    keys.some((key) => key !== "requestInput") ||
    (requestInput !== undefined && typeof requestInput !== "boolean")
  ) {
    return Response.json(
      { error: "Expected 'capabilities.requestInput' to be a boolean when provided.", ok: false },
      { status: 400 },
    );
  }

  return requestInput === undefined ? {} : { requestInput };
}

function parseModeField(value: unknown): RunMode | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "conversation" || value === "task") return value;
  return Response.json(
    { error: "Expected 'mode' to be either 'conversation' or 'task'.", ok: false },
    { status: 400 },
  );
}

function parseTurnPolicyField(value: unknown): TurnPolicy | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "queue" || value === "steer" || value === "interrupt") return value;
  return Response.json(
    { error: "Expected 'turnPolicy' to be 'queue', 'steer', or 'interrupt'.", ok: false },
    { status: 400 },
  );
}

function parseMessageField(value: unknown): string | UserContent | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;

  if (!Array.isArray(value)) {
    return Response.json(
      { error: "Expected 'message' to be a string or an array of text/file parts.", ok: false },
      { status: 400 },
    );
  }

  if (value.length === 0) return undefined;

  const parts: Array<TextPart | FilePart> = [];
  for (const raw of value) {
    const parsed = parseMessagePart(raw);
    if (parsed instanceof Response) return parsed;
    parts.push(parsed);
  }
  return parts;
}

function parseMessagePart(raw: unknown): TextPart | FilePart | Response {
  if (raw === null || typeof raw !== "object") {
    return Response.json(
      { error: "Expected each message part to be an object.", ok: false },
      { status: 400 },
    );
  }

  const part = raw as Record<string, unknown>;
  if (part.type === "text") {
    if (typeof part.text !== "string" || part.text.length === 0) {
      return Response.json(
        { error: "Text parts require a non-empty 'text' string.", ok: false },
        { status: 400 },
      );
    }
    return { type: "text", text: part.text };
  }

  if (part.type === "file") {
    if (typeof part.mediaType !== "string" || part.mediaType.length === 0) {
      return Response.json(
        { error: "File parts require a non-empty 'mediaType' string.", ok: false },
        { status: 400 },
      );
    }
    if (typeof part.data !== "string") {
      return Response.json(
        { error: "File parts require a 'data' string (base64, data URL, or URL).", ok: false },
        { status: 400 },
      );
    }
    // Callers must never supply framework-internal refs (`eve-url:`,
    // `eve-sandbox:`, `eve-attachment:`): the staging pipeline trusts the
    // scheme and would reconstitute the string into a privileged sandbox read.
    if (hasInternalRefScheme(part.data)) {
      return Response.json(
        { error: "File part 'data' must not use a framework-internal ref scheme.", ok: false },
        { status: 400 },
      );
    }
    const filePart: FilePart = { type: "file", mediaType: part.mediaType, data: part.data };
    if (typeof part.filename === "string" && part.filename.length > 0) {
      filePart.filename = part.filename;
    }
    return filePart;
  }

  return Response.json(
    {
      error: `Unsupported message part type "${String(part.type)}". Use 'text' or 'file'.`,
      ok: false,
    },
    { status: 400 },
  );
}

export function checkUploadPolicy(
  body: ParsedCreateBody | ParsedSessionMessageBody,
  policy: UploadPolicy,
): Response | null {
  if (!body.message) return null;
  const violations = collectUploadPolicyViolations(body.message, policy);
  if (violations.length === 0) return null;

  const [first] = violations;
  if (!first) return null;

  const status = first.kind === "too-large" ? 413 : 415;
  return Response.json(
    {
      error: formatUploadPolicyViolation(first),
      ok: false,
      violations: violations.map((v) =>
        v.kind === "too-large"
          ? {
              byteLength: v.byteLength,
              filename: v.filename,
              kind: v.kind,
              limit: v.limit,
              mediaType: v.mediaType,
            }
          : {
              allowedMediaTypes: v.allowedMediaTypes,
              filename: v.filename,
              kind: v.kind,
              mediaType: v.mediaType,
            },
      ),
    },
    { status },
  );
}

function parseInputResponses(
  value: unknown,
): readonly ValidatedInputResponse[] | Response | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    return Response.json(
      { error: "Expected 'inputResponses' to be a non-empty array.", ok: false },
      { status: 400 },
    );
  }
  const inputResponses = value.filter(isInputResponse);
  if (inputResponses.length !== value.length) {
    return Response.json(
      {
        error: "Expected every 'inputResponses' entry to match the HITL response schema.",
        ok: false,
      },
      { status: 400 },
    );
  }
  return inputResponses;
}

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

function parseClientContextField(value: unknown): string[] | Response | undefined {
  if (value === undefined) return undefined;

  if (typeof value === "string") {
    return value.length > 0 ? [toClientContextMessage(value)] : undefined;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;

    if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) {
      return Response.json(
        { error: "Expected 'clientContext' array entries to be non-empty strings.", ok: false },
        { status: 400 },
      );
    }

    return value.map((entry) => toClientContextMessage(entry));
  }

  if (value === null || typeof value !== "object") {
    return Response.json(
      {
        error: "Expected 'clientContext' to be a string, string array, or JSON object.",
        ok: false,
      },
      { status: 400 },
    );
  }

  try {
    const json = parseJsonObject(value);
    return [toClientContextMessage(JSON.stringify(json))];
  } catch {
    return Response.json(
      { error: "Expected 'clientContext' to be a JSON-serializable object.", ok: false },
      { status: 400 },
    );
  }
}

function toClientContextMessage(content: string): string {
  return `${CLIENT_CONTEXT_PREFIX}${content}`;
}

export function parseIncludeTailIndex(request: Request): boolean {
  const raw = new URL(request.url).searchParams.get("includeTailIndex");
  return raw === "1" || raw === "true";
}

export function parseStartIndex(request: Request): number | undefined | Response {
  const raw = new URL(request.url).searchParams.get("startIndex");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    return Response.json(
      { error: "Expected startIndex to be an integer.", ok: false },
      { status: 400 },
    );
  }
  return parsed;
}

function streamEventLimit(
  startIndex: number | undefined,
  tailIndex: number | undefined,
): number | undefined {
  if (tailIndex === undefined) return undefined;
  const resolvedStartIndex =
    startIndex === undefined
      ? 0
      : startIndex < 0
        ? Math.max(0, tailIndex + 1 + startIndex)
        : startIndex;
  return Math.max(0, tailIndex - resolvedStartIndex + 1);
}

function serializeAsNdjson(
  events: ReadableStream<unknown>,
  signal: AbortSignal,
  eventLimit?: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let eventCount = 0;
  const transform = new TransformStream<unknown, Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("\n"));
      if (eventLimit === 0) controller.terminate();
    },
    transform(event, controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      eventCount += 1;
      if (eventCount === eventLimit) controller.terminate();
    },
  });
  void events.pipeTo(transform.writable, { signal }).catch(() => {});
  return transform.readable;
}
