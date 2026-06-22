import { gateway, type Experimental_RealtimeFactoryGetTokenResult } from "ai";

import type { AuthFn } from "#public/channels/auth.js";
import { routeAuth } from "#public/channels/auth.js";
import { defineChannel, GET, POST, type Channel } from "#public/definitions/defineChannel.js";

const DEFAULT_BASE_PATH = "/eve/v1/realtime-speech";
const DEFAULT_MODEL = "openai/gpt-realtime-2";

export interface RealtimeSpeechChannelInput {
  /** Route auth used by the setup route. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** AI Gateway realtime model id. */
  readonly model?: string;
  /** Base path for the setup and health routes. */
  readonly basePath?: string;
  /** Client-secret TTL forwarded to AI Gateway. */
  readonly expiresAfterSeconds?: number;
  /** Test/advanced injection point for token minting. Defaults to AI Gateway. */
  readonly getToken?: (input: {
    readonly expiresAfterSeconds?: number;
    readonly model: string;
  }) => Promise<Experimental_RealtimeFactoryGetTokenResult>;
  /** Test/advanced injection point for creating long-lived voice session ids. */
  readonly createVoiceSessionId?: () => string;
}

export interface RealtimeSpeechSetupResponse extends Experimental_RealtimeFactoryGetTokenResult {
  /** No model-visible tools are exposed to the realtime speech adapter. */
  readonly tools: readonly [];
  readonly voiceSessionId: string;
}

/**
 * Builds an Eve channel for long-lived realtime speech sessions.
 *
 * The browser keeps an AI SDK realtime socket open to AI Gateway using the
 * setup route's short-lived `vcst_` token. Finalized transcripts are delivered
 * back into Eve as ordinary durable turns through the existing
 * `POST /eve/v1/session` (+ `/:sessionId`) routes and read back from the
 * session event stream — the realtime model is only the ears and mouth, while
 * Eve stays the durable assistant of record. The setup route mints the audio
 * token and returns a client-visible `voiceSessionId` used only to correlate
 * the audio socket and attribute Gateway usage; durable turns are bound to the
 * authenticated principal by normal session-route auth.
 */
export function realtimeSpeechChannel(input: RealtimeSpeechChannelInput): Channel {
  const basePath = normalizeBasePath(input.basePath ?? DEFAULT_BASE_PATH);
  const model = input.model ?? DEFAULT_MODEL;
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
          tools: [],
          voiceSessionId,
        } satisfies RealtimeSpeechSetupResponse);
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

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBasePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/u, "");
  if (!trimmed.startsWith("/") || trimmed.length === 0) {
    throw new Error("realtimeSpeechChannel basePath must start with `/`.");
  }
  return trimmed;
}

function jsonNoStore(body: unknown): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
