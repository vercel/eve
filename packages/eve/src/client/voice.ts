export const EVE_VOICE_SETUP_ROUTE_PATH = "/eve/v1/realtime-speech/setup";

export interface EveVoiceSetupResult {
  readonly control?: boolean;
  readonly expiresAt?: number;
  readonly token: string;
  readonly url: string;
  readonly voiceSessionId: string;
}

/**
 * Minimal authenticated-fetch surface needed to mint a realtime voice token.
 *
 * {@link import("#client/client.js").Client} satisfies this, but the helper
 * stays decoupled so it can run against any same-auth transport.
 */
export interface VoiceTokenClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface SetupVoiceOptions {
  /** Override the setup route when the channel uses a custom `basePath`. */
  readonly setupUrl?: string;
  /** Reuse an existing voice session id instead of letting the server mint one. */
  readonly voiceSessionId?: string;
}

/**
 * Appends the voice session id to a realtime-speech setup URL.
 *
 * Works for both relative same-origin routes (`/eve/v1/realtime-speech/setup`)
 * and absolute origins. The realtime audio socket and Gateway usage attribution
 * are keyed by this id; durable Eve turns are bound to the authenticated
 * principal by normal session-route auth, not by this value.
 */
export function voiceSetupUrl(baseUrl: string, voiceSessionId: string): string {
  const absolute = /^https?:\/\//u.test(baseUrl);
  const parsed = new URL(baseUrl, "https://eve.local");
  parsed.searchParams.set("voiceSessionId", voiceSessionId);
  if (absolute) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Mints a short-lived AI Gateway realtime token for a voice client.
 *
 * This is the one genuinely voice-specific concern that the durable session
 * API does not cover: opening the browser/audio socket to AI Gateway. Run
 * normal turns with {@link import("#client/session.js").ClientSession} via
 * `client.session().send(...)`; use this only to obtain the realtime audio
 * token and `voiceSessionId`.
 */
export async function setupVoice(
  client: VoiceTokenClient,
  options: SetupVoiceOptions = {},
): Promise<EveVoiceSetupResult> {
  const voiceSessionId = options.voiceSessionId ?? crypto.randomUUID();
  const url = voiceSetupUrl(options.setupUrl ?? EVE_VOICE_SETUP_ROUTE_PATH, voiceSessionId);

  const response = await client.fetch(url, {
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const data = (await response.json().catch(() => ({}))) as Partial<EveVoiceSetupResult> & {
    readonly error?: unknown;
  };
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Eve voice setup failed.");
  }
  if (typeof data.token !== "string" || typeof data.url !== "string") {
    throw new Error("Eve voice setup response was malformed.");
  }

  const resolvedVoiceSessionId =
    typeof data.voiceSessionId === "string" && data.voiceSessionId.length > 0
      ? data.voiceSessionId
      : voiceSessionId;

  const result: {
    control?: boolean;
    expiresAt?: number;
    token: string;
    url: string;
    voiceSessionId: string;
  } = {
    token: data.token,
    url: data.url,
    voiceSessionId: resolvedVoiceSessionId,
  };
  if (typeof data.control === "boolean") result.control = data.control;
  if (typeof data.expiresAt === "number") result.expiresAt = data.expiresAt;
  return result;
}
