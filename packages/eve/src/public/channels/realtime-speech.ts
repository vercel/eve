import { gateway, type Experimental_RealtimeFactoryGetTokenResult } from "ai";

import type { AuthFn } from "#public/channels/auth.js";
import { routeAuth } from "#public/channels/auth.js";
import { defineChannel, GET, POST, type Channel } from "#public/definitions/defineChannel.js";
import type { Session } from "#channel/session.js";

const DEFAULT_BASE_PATH = "/eve/v1/realtime-speech";
const DEFAULT_MODEL = "openai/gpt-realtime-2";
const DEFAULT_FALLBACK_REPLY = "Sorry, I ran into a problem. Could you say that again?";

export interface RealtimeSpeechChannelInput {
  /** Route auth used by setup and turn routes. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** AI Gateway realtime model id. */
  readonly model?: string;
  /** Base path for setup, turn, and health routes. */
  readonly basePath?: string;
  /** Client-secret TTL forwarded to AI Gateway. */
  readonly expiresAfterSeconds?: number;
  /** Fallback text returned when the Ash turn fails before producing text. */
  readonly fallbackReply?: string;
  /** Test/advanced injection point for token minting. Defaults to AI Gateway. */
  readonly getToken?: (input: {
    readonly expiresAfterSeconds?: number;
    readonly model: string;
  }) => Promise<Experimental_RealtimeFactoryGetTokenResult>;
  /** Test/advanced injection point for creating long-lived voice session ids. */
  readonly createVoiceSessionId?: () => string;
}

export interface RealtimeSpeechSetupResponse extends Experimental_RealtimeFactoryGetTokenResult {
  readonly voiceSessionId: string;
}

export interface RealtimeSpeechTurnResponse {
  readonly ok: true;
  readonly continuationToken: string;
  readonly sessionId: string;
  readonly streamIndex: number;
  readonly text: string;
  readonly voiceSessionId: string;
}

interface RealtimeSpeechTurnRequest {
  readonly context?: readonly string[];
  readonly message: string;
  readonly sessionId?: string;
  readonly streamIndex: number;
  readonly voiceSessionId: string;
}

/**
 * Builds an Ash channel for long-lived realtime speech sessions.
 *
 * The browser keeps an AI SDK realtime socket open to AI Gateway using the
 * setup route's short-lived `vcst_` token. Each finalized speech request is
 * bridged back into Ash through the turn route using the same `voiceSessionId`
 * as the channel continuation token, so Ash still processes normal durable
 * turns and parks between utterances.
 */
export function realtimeSpeechChannel(input: RealtimeSpeechChannelInput): Channel {
  const basePath = normalizeBasePath(input.basePath ?? DEFAULT_BASE_PATH);
  const model = input.model ?? DEFAULT_MODEL;
  const fallbackReply = input.fallbackReply ?? DEFAULT_FALLBACK_REPLY;
  const getToken =
    input.getToken ??
    ((options: { readonly expiresAfterSeconds?: number; readonly model: string }) =>
      gateway.experimental_realtime.getToken(options));
  const createVoiceSessionId = input.createVoiceSessionId ?? (() => crypto.randomUUID());

  return defineChannel({
    kindHint: "realtime-speech",
    routes: [
      POST(`${basePath}/setup`, async (req) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const url = new URL(req.url);
        const voiceSessionId =
          readOptionalString(url.searchParams.get("voiceSessionId")) ?? createVoiceSessionId();
        const token = await getToken({
          model,
          ...(input.expiresAfterSeconds !== undefined
            ? { expiresAfterSeconds: input.expiresAfterSeconds }
            : {}),
        });

        return jsonNoStore({
          ...token,
          voiceSessionId,
        } satisfies RealtimeSpeechSetupResponse);
      }),

      POST(`${basePath}/turn`, async (req, { send }) => {
        const authResult = await routeAuth(req, input.auth);
        if (authResult instanceof Response) return authResult;

        const body = await parseTurnRequest(req);
        if (body instanceof Response) return body;

        const session = await send(
          {
            context: body.context,
            message: body.message,
          },
          {
            auth: authResult,
            continuationToken: body.voiceSessionId,
            mode: "conversation",
          },
        );

        const reply = await readTurnReply({
          fallbackReply,
          session,
          startIndex:
            body.sessionId === undefined || body.sessionId === session.id ? body.streamIndex : 0,
        });

        return jsonNoStore({
          ok: true,
          continuationToken: session.continuationToken,
          sessionId: session.id,
          streamIndex: reply.streamIndex,
          text: reply.text,
          voiceSessionId: body.voiceSessionId,
        } satisfies RealtimeSpeechTurnResponse);
      }),

      GET(`${basePath}/health`, async () =>
        jsonNoStore({
          ok: true,
          channel: "realtime-speech",
          model,
        }),
      ),
    ],
  });
}

async function parseTurnRequest(req: Request): Promise<RealtimeSpeechTurnRequest | Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return badRequest("Expected a JSON object.");
  }

  const record = payload as Record<string, unknown>;
  const message = readOptionalString(record.message);
  if (message === undefined) return badRequest("Expected non-empty string field `message`.");

  const voiceSessionId = readOptionalString(record.voiceSessionId);
  if (voiceSessionId === undefined) {
    return badRequest("Expected non-empty string field `voiceSessionId`.");
  }

  const streamIndex = readStreamIndex(record.streamIndex);
  if (streamIndex instanceof Response) return streamIndex;

  const sessionId = readOptionalString(record.sessionId);

  const context = readContext(record.context);
  if (context instanceof Response) return context;

  return {
    context,
    message,
    sessionId,
    streamIndex,
    voiceSessionId,
  };
}

async function readTurnReply(input: {
  readonly fallbackReply: string;
  readonly session: Session;
  readonly startIndex: number;
}): Promise<{ readonly streamIndex: number; readonly text: string }> {
  const stream = await input.session.getEventStream({ startIndex: input.startIndex });
  const reader = stream.getReader();

  let consumed = 0;
  let sawTurn = false;
  const completedMessages: string[] = [];
  const partialMessages = new Map<number, string>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumed++;

      switch (value.type) {
        case "turn.started":
        case "step.started":
          sawTurn = true;
          break;
        case "message.appended":
          sawTurn = true;
          partialMessages.set(
            value.data.stepIndex,
            (partialMessages.get(value.data.stepIndex) ?? "") + value.data.messageDelta,
          );
          break;
        case "message.completed":
          sawTurn = true;
          completedMessages.push(
            partialMessages.get(value.data.stepIndex) || value.data.message || "",
          );
          partialMessages.delete(value.data.stepIndex);
          break;
        case "turn.failed":
        case "session.failed":
          return {
            streamIndex: input.startIndex + consumed,
            text: collectReplyText(completedMessages, partialMessages) || input.fallbackReply,
          };
        case "session.completed":
          return {
            streamIndex: input.startIndex + consumed,
            text: collectReplyText(completedMessages, partialMessages),
          };
        case "session.waiting":
          if (sawTurn) {
            return {
              streamIndex: input.startIndex + consumed,
              text: collectReplyText(completedMessages, partialMessages) || input.fallbackReply,
            };
          }
          break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best effort: some in-memory test streams are already closed.
    }
  }

  return {
    streamIndex: input.startIndex + consumed,
    text: collectReplyText(completedMessages, partialMessages) || input.fallbackReply,
  };
}

function collectReplyText(
  completedMessages: readonly string[],
  partialMessages: ReadonlyMap<number, string>,
): string {
  return [...completedMessages, ...partialMessages.values()]
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .join("\n\n");
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStreamIndex(value: unknown): number | Response {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return badRequest("Expected optional non-negative integer field `streamIndex`.");
  }
  return value;
}

function readContext(value: unknown): readonly string[] | Response | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  return badRequest("Expected optional `context` to be a string or string array.");
}

function normalizeBasePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/u, "");
  if (!trimmed.startsWith("/") || trimmed.length === 0) {
    throw new Error("realtimeSpeechChannel basePath must start with `/`.");
  }
  return trimmed;
}

function badRequest(message: string): Response {
  return Response.json({ error: message, ok: false }, { status: 400 });
}

function jsonNoStore(body: unknown): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
