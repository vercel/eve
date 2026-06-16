export const EVE_VOICE_SETUP_ROUTE_PATH = "/eve/v1/realtime-speech/setup";
export const EVE_VOICE_TURN_ROUTE_PATH = "/eve/v1/realtime-speech/turn";

export interface EveVoiceSetupResult {
  readonly expiresAt?: number;
  readonly token: string;
  readonly url: string;
  readonly voiceSessionId: string;
}

export interface EveVoiceTurnResult {
  readonly continuationToken: string;
  readonly sessionId: string;
  readonly streamIndex: number;
  readonly text: string;
  readonly voiceSessionId: string;
}

export interface EveVoiceSessionState {
  readonly sessionId?: string;
  readonly streamIndex: number;
  readonly voiceSessionId: string;
}

export interface EveVoiceSessionOptions {
  readonly fetch?: typeof fetch;
  readonly setupUrl?: string;
  readonly state?: EveVoiceSessionState;
  readonly turnUrl?: string;
  readonly voiceSessionId?: string;
}

export type EveVoiceTurnInput =
  | string
  | {
      readonly context?: string | readonly string[];
      readonly message: string;
    };

/**
 * Transport-agnostic client for the Eve realtime speech channel.
 *
 * Browser React UIs, a future terminal UI, or any other speech surface can use
 * this to map finalized transcripts into durable Eve turns while keeping the
 * same voice session id and stream cursor across utterances.
 */
export class EveVoiceSession {
  readonly #fetch: typeof fetch;
  readonly #setupUrl: string;
  readonly #turnUrl: string;
  #state: EveVoiceSessionState;

  constructor(options: EveVoiceSessionOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#setupUrl = options.setupUrl ?? EVE_VOICE_SETUP_ROUTE_PATH;
    this.#turnUrl = options.turnUrl ?? EVE_VOICE_TURN_ROUTE_PATH;
    this.#state = options.state ?? {
      streamIndex: 0,
      voiceSessionId: options.voiceSessionId ?? crypto.randomUUID(),
    };
  }

  get state(): EveVoiceSessionState {
    return this.#state;
  }

  get setupUrl(): string {
    return withVoiceSessionId(this.#setupUrl, this.#state.voiceSessionId);
  }

  async setup(): Promise<EveVoiceSetupResult> {
    const response = await this.#fetch(this.setupUrl, {
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

    const voiceSessionId =
      typeof data.voiceSessionId === "string" && data.voiceSessionId.length > 0
        ? data.voiceSessionId
        : this.#state.voiceSessionId;
    this.#state = { ...this.#state, voiceSessionId };

    return {
      token: data.token,
      url: data.url,
      voiceSessionId,
      ...(typeof data.expiresAt === "number" ? { expiresAt: data.expiresAt } : {}),
    };
  }

  async sendTranscript(input: EveVoiceTurnInput): Promise<EveVoiceTurnResult> {
    const payload = normalizeTurnInput(input);
    const response = await this.#fetch(this.#turnUrl, {
      body: JSON.stringify({
        context: payload.context,
        message: payload.message,
        sessionId: this.#state.sessionId,
        streamIndex: this.#state.streamIndex,
        voiceSessionId: this.#state.voiceSessionId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const data = (await response.json().catch(() => ({}))) as Partial<EveVoiceTurnResult> & {
      readonly error?: unknown;
    };
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : "Eve voice turn failed.");
    }
    if (
      typeof data.continuationToken !== "string" ||
      typeof data.sessionId !== "string" ||
      typeof data.streamIndex !== "number" ||
      typeof data.text !== "string" ||
      typeof data.voiceSessionId !== "string"
    ) {
      throw new Error("Eve voice turn response was malformed.");
    }

    this.#state = {
      sessionId: data.sessionId,
      streamIndex: data.streamIndex,
      voiceSessionId: data.voiceSessionId,
    };

    return {
      continuationToken: data.continuationToken,
      sessionId: data.sessionId,
      streamIndex: data.streamIndex,
      text: data.text,
      voiceSessionId: data.voiceSessionId,
    };
  }
}

function normalizeTurnInput(input: EveVoiceTurnInput): {
  readonly context?: string | readonly string[];
  readonly message: string;
} {
  if (typeof input === "string") return { message: input };
  return input;
}

function withVoiceSessionId(url: string, voiceSessionId: string): string {
  const absolute = /^https?:\/\//u.test(url);
  const parsed = new URL(url, "https://eve.local");
  parsed.searchParams.set("voiceSessionId", voiceSessionId);
  if (absolute) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
