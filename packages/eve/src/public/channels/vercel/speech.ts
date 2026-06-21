import { gateway } from "ai";

import type { AuthFn } from "#public/channels/auth.js";
import { routeAuth } from "#public/channels/auth.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  defineChannel,
  GET,
  POST,
  WS,
  type Channel,
  type RouteDefinition,
} from "#public/definitions/defineChannel.js";
import {
  createControlToken,
  resolveControlSecret,
  verifyControlToken,
} from "#public/channels/vercel/control-token.js";
import { resolveControlUrl } from "#public/channels/vercel/control-url.js";
import {
  EVE_VOICE_CONTROL_PROTOCOL,
  parseControlPacket,
} from "#public/channels/vercel/voice-control-protocol.js";
import {
  createInMemoryVoiceControlStateStore,
  VoiceTurnCoordinator,
  type VoiceControlStateStore,
  type VoiceTurnCoordinatorOptions,
} from "#public/channels/vercel/voice-turn-coordinator.js";

const DEFAULT_BASE_PATH = "/eve/v1/realtime-speech";
const DEFAULT_MODEL = "openai/gpt-realtime-2";
const DEFAULT_CONTROL_TOKEN_TTL_SECONDS = 600;

/**
 * Gateway-owned control plane ("A-lite") configuration. When set, the setup
 * route mints a `vcst_` token carrying an Eve control socket config, and the
 * channel serves the `WS()` control route AI Gateway dials back. Pass `true`
 * for defaults.
 */
export interface VercelSpeechControlInput {
  /** HMAC secret for control tokens. Defaults to `EVE_REALTIME_CONTROL_SECRET`. */
  readonly secret?: string;
  /** Allow deriving the control-token signing secret from `AI_GATEWAY_API_KEY`. Local/preview only. */
  readonly allowGatewayKeyFallback?: boolean;
  /** Full `wss://` control URL override. Defaults to `EVE_REALTIME_CONTROL_URL` / deployment host. */
  readonly controlUrl?: string;
  /** Vercel deploy-protection bypass secret override (for protected previews). */
  readonly bypassSecret?: string;
  /** Control-token TTL (seconds). Default 600. */
  readonly tokenTtlSeconds?: number;
  /** Durable context strings contributed on each control-driven turn. */
  readonly context?: readonly string[];
  /** Durable state for continuation/cursor recovery across control WS reconnects. */
  readonly stateStore?: VoiceControlStateStore;
  /** Turn settle/debounce window (ms). */
  readonly settleMs?: number;
}

/**
 * Eve-owned mirror of the AI Gateway realtime client-secret result (`token`,
 * `url`, `expiresAt`). Declared locally so eve's public channel surface does not
 * re-export the AI SDK's experimental realtime types, which can change freely.
 */
export interface VercelRealtimeClientSecret {
  readonly token: string;
  readonly url: string;
  readonly expiresAt?: number;
}

/**
 * Gateway realtime `control` config sealed into the minted token. Structurally
 * mirrors `@ai-sdk/gateway`'s `GatewayRealtimeControlConfig`; defined locally so
 * eve does not depend on the gateway type re-export.
 */
export interface VercelRealtimeControlConfig {
  readonly mode: "eve";
  readonly token: string;
  readonly url: string;
}

export interface VercelSpeechGetTokenInput {
  readonly expiresAfterSeconds?: number;
  readonly model: string;
  readonly control?: VercelRealtimeControlConfig;
}

export interface VercelSpeechChannelInput {
  /** Route auth used by the setup route. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** AI Gateway realtime model id. */
  readonly model?: string;
  /** Base path for the setup, health, and control routes. */
  readonly basePath?: string;
  /** Client-secret TTL forwarded to AI Gateway. */
  readonly expiresAfterSeconds?: number;
  /**
   * Enable the Gateway-owned control plane (A-lite). When set, `/setup` mints a
   * token with control config and the `{basePath}/ws` control route is served.
   */
  readonly control?: VercelSpeechControlInput | boolean;
  /** Test/advanced injection point for token minting. Defaults to AI Gateway. */
  readonly getToken?: (input: VercelSpeechGetTokenInput) => Promise<VercelRealtimeClientSecret>;
  /** Test/advanced injection point for creating long-lived voice session ids. */
  readonly createVoiceSessionId?: () => string;
}

export interface VercelSpeechSetupResponse extends VercelRealtimeClientSecret {
  /** Whether this token carries Gateway-owned Eve control config. */
  readonly control: boolean;
  /** No model-visible tools are exposed to the realtime speech adapter. */
  readonly tools: readonly [];
  readonly voiceSessionId: string;
}

/**
 * Builds an Eve channel for long-lived realtime speech sessions backed by Vercel
 * AI Gateway realtime audio.
 *
 * Default (client-driven) mode: the browser keeps an AI Gateway realtime socket
 * open using the setup route's short-lived `vcst_` token, and finalized
 * transcripts run as ordinary durable turns through `/eve/v1/session`.
 *
 * Gateway-control mode (A-lite, opt in via `control`): `/setup` additionally
 * mints control config into the token so AI Gateway dials Eve's `{basePath}/ws`
 * route per session; Eve then owns turn coordination and streams reply text back
 * for Gateway to inject into provider TTS. Either way the realtime model is only
 * the ears and mouth and Eve stays the durable assistant of record.
 */
export function vercelSpeechChannel(input: VercelSpeechChannelInput): Channel {
  const basePath = normalizeBasePath(input.basePath ?? DEFAULT_BASE_PATH);
  const model = input.model ?? DEFAULT_MODEL;
  const getToken =
    input.getToken ??
    ((options: VercelSpeechGetTokenInput) => gateway.experimental_realtime.getToken(options));
  const createVoiceSessionId = input.createVoiceSessionId ?? (() => crypto.randomUUID());
  const controlOptions = normalizeControlInput(input.control);
  const wsPath = `${basePath}/ws`;

  const routes: RouteDefinition[] = [
    POST(`${basePath}/setup`, async (req) => {
      const authResult = await routeAuth(req, input.auth);
      if (authResult instanceof Response) return authResult;

      const url = new URL(req.url);
      const voiceSessionId =
        readOptionalString(url.searchParams.get("voiceSessionId")) ?? createVoiceSessionId();

      let control: VercelRealtimeControlConfig | undefined;
      if (controlOptions !== undefined) {
        const secret = resolveControlSecret(controlOptions.secret, {
          allowGatewayKeyFallback: controlOptions.allowGatewayKeyFallback,
        });
        const token = await createControlToken({
          auth: authResult,
          voiceSessionId,
          ttlSeconds: controlOptions.tokenTtlSeconds ?? DEFAULT_CONTROL_TOKEN_TTL_SECONDS,
          secret,
        });
        const controlUrlInput: {
          wsPath: string;
          explicitUrl?: string;
          bypassSecret?: string;
        } = { wsPath };
        if (controlOptions.controlUrl !== undefined) {
          controlUrlInput.explicitUrl = controlOptions.controlUrl;
        }
        if (controlOptions.bypassSecret !== undefined) {
          controlUrlInput.bypassSecret = controlOptions.bypassSecret;
        }
        control = { mode: "eve", token, url: resolveControlUrl(controlUrlInput) };
      }

      const getTokenInput: {
        model: string;
        expiresAfterSeconds?: number;
        control?: VercelRealtimeControlConfig;
      } = { model };
      if (input.expiresAfterSeconds !== undefined) {
        getTokenInput.expiresAfterSeconds = input.expiresAfterSeconds;
      }
      if (control !== undefined) getTokenInput.control = control;
      const token = await getToken(getTokenInput);

      return jsonNoStore({
        ...token,
        control: control !== undefined,
        tools: [],
        voiceSessionId,
      } satisfies VercelSpeechSetupResponse);
    }),

    GET(`${basePath}/health`, async () =>
      jsonNoStore({
        ok: true,
        channel: "realtime-speech",
        control: controlOptions !== undefined,
        model,
      }),
    ),
  ];

  if (controlOptions !== undefined) {
    routes.push(createControlRoute({ wsPath, controlOptions }));
  }

  return defineChannel({
    kindHint: "realtime-speech",
    routes,
  });
}

function createControlRoute(input: {
  readonly wsPath: string;
  readonly controlOptions: VercelSpeechControlInput;
}): RouteDefinition {
  // Per-connection coordinators, keyed by peer id. eve invokes the WS route
  // handler per hook (upgrade/open/message run in separate closures), so
  // connection state cannot live in the handler closure — it is keyed here on
  // the stable `peer.id`, and the principal is recovered from `peer.request`.
  const connections = new Map<string, VoiceTurnCoordinator>();
  const stateStore = input.controlOptions.stateStore ?? createInMemoryVoiceControlStateStore();

  async function verifyPeer(
    request: Request,
  ): Promise<{ auth: SessionAuthContext; voiceSessionId: string } | undefined> {
    let secret: string;
    try {
      secret = resolveControlSecret(input.controlOptions.secret, {
        allowGatewayKeyFallback: input.controlOptions.allowGatewayKeyFallback,
      });
    } catch {
      return undefined;
    }
    const result = await verifyControlToken(readBearerToken(request.headers.get("authorization")), {
      secret,
    });
    return result.ok ? { auth: result.auth, voiceSessionId: result.voiceSessionId } : undefined;
  }

  return WS(input.wsPath, (_req, args) => ({
    async upgrade(request) {
      // Reject bad tokens at the handshake for a clean 401.
      const verified = await verifyPeer(request);
      if (verified === undefined) return new Response("Unauthorized", { status: 401 });
      return { headers: { "sec-websocket-protocol": EVE_VOICE_CONTROL_PROTOCOL } };
    },
    async open(peer) {
      const verified = await verifyPeer(peer.request);
      if (verified === undefined) {
        peer.close(1011, "unverified");
        return;
      }
      const coordinatorOptions: {
        -readonly [K in keyof VoiceTurnCoordinatorOptions]: VoiceTurnCoordinatorOptions[K];
      } = {
        auth: verified.auth,
        voiceSessionId: verified.voiceSessionId,
        send: args.send,
        sendRaw: (packet) => peer.send(packet),
        stateStore,
        closeSocket: (code, reason) => peer.close(code, reason),
      };
      if (input.controlOptions.context !== undefined) {
        coordinatorOptions.context = input.controlOptions.context;
      }
      if (input.controlOptions.settleMs !== undefined) {
        coordinatorOptions.settleMs = input.controlOptions.settleMs;
      }
      const coordinator = new VoiceTurnCoordinator(coordinatorOptions);
      connections.set(peer.id, coordinator);
      coordinator.start();
    },
    message(peer, message) {
      const event = parseControlPacket(message.text());
      if (event !== null) connections.get(peer.id)?.handle(event);
    },
    close(peer) {
      connections.get(peer.id)?.dispose();
      connections.delete(peer.id);
    },
    error(peer) {
      connections.get(peer.id)?.dispose();
      connections.delete(peer.id);
    },
  }));
}

function normalizeControlInput(
  control: VercelSpeechChannelInput["control"],
): VercelSpeechControlInput | undefined {
  if (control === undefined || control === false) return undefined;
  if (control === true) return {};
  return control;
}

function readBearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1];
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBasePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/u, "");
  if (!trimmed.startsWith("/") || trimmed.length === 0) {
    throw new Error("vercelSpeechChannel basePath must start with `/`.");
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
