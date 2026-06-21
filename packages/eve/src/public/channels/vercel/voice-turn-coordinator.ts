import type { SendFn } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";
import {
  DEFAULT_CONTROL_CAPABILITIES,
  encodeControlPacket,
  type EveToGatewayEvent,
  type GatewayToEveEvent,
  type RealtimeControlCapabilities,
} from "#public/channels/vercel/voice-control-protocol.js";

/** Settle delay before a finalized transcript starts a turn; coalesces rapid finals. */
const DEFAULT_SETTLE_MS = 220;
/** Bounds the dedupe set so a long session does not grow it without limit. */
const MAX_TRACKED_ITEMS = 256;
/** Suppresses immediate duplicate transcript finals when Gateway omits item ids. */
const TEXT_DEDUPE_MS = 10_000;

/** Short acknowledgements that should not trigger a durable Eve turn. */
const BACKCHANNELS = new Set([
  "ok",
  "okay",
  "yeah",
  "yep",
  "yup",
  "uh huh",
  "uh-huh",
  "mhm",
  "mm",
  "mm-hmm",
  "mmhmm",
  "right",
  "sure",
  "got it",
  "cool",
  "nice",
  "hmm",
  "huh",
  "okay cool",
]);

export interface VoiceTurnCoordinatorOptions {
  readonly auth: SessionAuthContext;
  readonly voiceSessionId: string;
  /** Channel `send`, used to run durable Eve turns. */
  readonly send: SendFn;
  /** Sends a wire packet string to AI Gateway (the open WS peer). */
  readonly sendRaw: (packet: string) => void;
  /** Closes the control socket with a code/reason (fail-closed). */
  readonly closeSocket: (code: number, reason: string) => void;
  /** Optional durable context strings contributed on each turn. */
  readonly context?: readonly string[];
  /** Stores durable voice continuation/cursor state across control WS reconnects. */
  readonly stateStore?: VoiceControlStateStore;
  /** Settle delay override (ms). */
  readonly settleMs?: number;
}

export interface VoiceControlSessionState {
  readonly continuationToken: string;
  readonly sessionId?: string;
  readonly streamIndex: number;
}

export interface VoiceControlStateStore {
  get(
    key: string,
  ): Promise<VoiceControlSessionState | undefined> | VoiceControlSessionState | undefined;
  set(key: string, state: VoiceControlSessionState): Promise<void> | void;
}

export function createInMemoryVoiceControlStateStore(): VoiceControlStateStore {
  const states = new Map<string, VoiceControlSessionState>();
  return {
    get(key) {
      return states.get(key);
    },
    set(key, state) {
      states.set(key, { ...state });
    },
  };
}

/**
 * Drives durable Eve turns from the Gateway-owned realtime voice control socket.
 *
 * It receives finalized transcripts (and lifecycle/barge-in signals) from AI
 * Gateway, debounces and de-duplicates them, runs one durable Eve turn per
 * settled utterance via the channel `send`, and streams non-tool-call reply text
 * back as `response.delta` / `response.done`. A user barge-in aborts the
 * in-flight turn's relay and emits `response.cancel`.
 *
 * It degrades gracefully against the per-session capability hints the Gateway
 * advertises in `session.opened.data.engine`: with `output.audio: false` it
 * still runs the durable turn but skips the spoken readout; with
 * `output.cancel: false` it aborts the local relay on barge-in without emitting
 * `response.cancel`; it only consumes final transcripts; and it only reacts to
 * an actual `input.interrupted` / `input.speech.started`, so it never promises
 * barge-in the provider cannot honor.
 */
export class VoiceTurnCoordinator {
  readonly #options: VoiceTurnCoordinatorOptions;
  readonly #settleMs: number;
  readonly #stateKey: string;
  readonly #stateReady: Promise<void>;
  readonly #processedItemIds = new Set<string>();
  readonly #processedTextFingerprints = new Map<string, number>();

  #seq = 0;
  #turnSeq = 0;
  #disposed = false;
  #continuationToken: string;
  #lastSessionId: string | undefined;
  #streamIndex = 0;

  #pendingText = "";
  #settleTimer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #activeTurn:
    | { readonly abort: AbortController; cancelStream: () => void; readonly turnId: string }
    | undefined;
  #responseInFlight = false;
  #capabilities: RealtimeControlCapabilities = DEFAULT_CONTROL_CAPABILITIES;

  constructor(options: VoiceTurnCoordinatorOptions) {
    this.#options = options;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#stateKey = createStateKey(options.auth, options.voiceSessionId);
    this.#continuationToken = createStableContinuationToken(options.auth, options.voiceSessionId);
    this.#stateReady = this.#hydrateState();
  }

  /** Signals readiness so Gateway clears its ready timeout. */
  start(): void {
    void this.#stateReady.then(
      () => this.#emit({ type: "session.ready" }),
      () => this.#fail("state_load_failed"),
    );
  }

  /** Routes one inbound Gateway→Eve control event. */
  handle(event: GatewayToEveEvent): void {
    if (this.#disposed) return;
    switch (event.type) {
      case "session.opened":
        if (event.data.engine !== undefined) this.#capabilities = event.data.engine.capabilities;
        return;
      case "input.transcript.final":
        this.#onTranscriptFinal(event.data.text, event.data.itemId);
        return;
      case "input.speech.started":
      case "input.interrupted":
        this.#bargeIn();
        return;
      case "session.closed":
        this.dispose();
        return;
      case "error":
        this.dispose();
        return;
      // input.speech.stopped / session.stats — no action.
      default:
        return;
    }
  }

  /** Tears down timers and aborts any in-flight turn. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearSettle();
    this.#activeTurn?.abort.abort();
    this.#activeTurn?.cancelStream();
    this.#activeTurn = undefined;
  }

  #onTranscriptFinal(rawText: string, itemId?: string): void {
    const text = rawText.trim();
    if (text.length === 0) return;
    if (itemId !== undefined) {
      if (this.#processedItemIds.has(itemId)) return;
      this.#processedItemIds.add(itemId);
      if (this.#processedItemIds.size > MAX_TRACKED_ITEMS) {
        const oldest = this.#processedItemIds.values().next().value;
        if (oldest !== undefined) this.#processedItemIds.delete(oldest);
      }
    }
    if (isBackchannel(text)) return;
    if (itemId === undefined && this.#isDuplicateText(text)) return;

    this.#pendingText = this.#pendingText.length > 0 ? `${this.#pendingText} ${text}` : text;
    this.#clearSettle();
    this.#settleTimer = setTimeout(() => this.#flushPending(), this.#settleMs);
  }

  #flushPending(): void {
    this.#settleTimer = undefined;
    const message = this.#pendingText;
    this.#pendingText = "";
    if (message.length === 0 || this.#disposed) return;
    this.#queue = this.#queue.catch(() => undefined).then(() => this.#runTurn(message));
  }

  #bargeIn(): void {
    this.#clearSettle();
    this.#pendingText = "";
    const cancelledTurnId = this.#activeTurn?.turnId;
    const hadResponse = this.#responseInFlight || this.#activeTurn !== undefined;
    this.#activeTurn?.abort.abort();
    if (hadResponse) {
      // Skip the cancel frame when the engine can't act on it; the local relay
      // is already aborted above either way. The durable stream is still drained
      // to its boundary so the next turn cannot race the same continuation.
      if (this.#capabilities["output.cancel"] && cancelledTurnId !== undefined) {
        this.#emit({ type: "response.cancel", data: { turnId: cancelledTurnId } });
      }
      this.#responseInFlight = false;
    }
  }

  async #runTurn(message: string): Promise<void> {
    if (this.#disposed) return;
    await this.#stateReady;
    const abort = new AbortController();
    const turnId = `turn_${(this.#turnSeq += 1)}`;
    const turn = { abort, cancelStream: () => undefined as void, turnId };
    this.#activeTurn = turn;
    let session: Session | undefined;
    let consumed = 0;
    let failed = false;

    try {
      this.#emit({ type: "turn.started", data: { turnId } });
      const payload: { message: string; context?: readonly string[] } = { message };
      if (this.#options.context !== undefined) payload.context = this.#options.context;
      session = await this.#options.send(payload, {
        auth: this.#options.auth,
        continuationToken: this.#continuationToken,
        mode: "conversation",
      });

      const startIndex = this.#lastSessionId === session.id ? this.#streamIndex : 0;
      const stream = await session.getEventStream({ startIndex });
      const reader = stream.getReader();
      turn.cancelStream = () => {
        void reader.cancel().catch(() => undefined);
      };

      const partials = new Map<number, string>();
      try {
        while (!this.#disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          consumed += 1;
          const event = value;
          if (isTurnFailureEvent(event)) {
            failed = true;
            break;
          }
          if (event.type === "message.appended") {
            partials.set(
              event.data.stepIndex,
              (partials.get(event.data.stepIndex) ?? "") + event.data.messageDelta,
            );
          } else if (event.type === "message.completed") {
            if (event.data.finishReason === "tool-calls") {
              partials.delete(event.data.stepIndex);
              continue;
            }
            const text = (partials.get(event.data.stepIndex) || event.data.message || "").trim();
            partials.delete(event.data.stepIndex);
            // The durable turn always runs; only stream the spoken readout when
            // the engine can actually speak it (`output.audio`).
            if (text.length > 0 && !abort.signal.aborted && this.#capabilities["output.audio"]) {
              this.#emit({ type: "response.delta", data: { text, turnId } });
              this.#responseInFlight = true;
            }
          } else if (isCurrentTurnBoundaryEvent(event)) {
            break;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // Best effort.
        }
      }

      await this.#persistState(session, startIndex + consumed);

      if (failed) {
        this.#responseInFlight = false;
        if (!abort.signal.aborted && !this.#disposed) {
          this.#emit({ type: "error", data: { message: "turn_failed" } });
        }
        return;
      }

      if (!abort.signal.aborted && !this.#disposed) {
        this.#emit({ type: "response.done", data: { turnId } });
        this.#responseInFlight = false;
      }
    } catch {
      this.#responseInFlight = false;
      if (!abort.signal.aborted && !this.#disposed) {
        this.#emit({ type: "error", data: { message: "turn_failed" } });
      }
    } finally {
      if (this.#activeTurn === turn) this.#activeTurn = undefined;
    }
  }

  async #hydrateState(): Promise<void> {
    const state = await this.#options.stateStore?.get(this.#stateKey);
    if (state === undefined) return;
    if (state.continuationToken.length > 0) this.#continuationToken = state.continuationToken;
    this.#lastSessionId = state.sessionId;
    this.#streamIndex = Math.max(0, Math.floor(state.streamIndex));
  }

  async #persistState(session: Session, streamIndex: number): Promise<void> {
    this.#lastSessionId = session.id;
    this.#streamIndex = streamIndex;
    await this.#options.stateStore?.set(this.#stateKey, {
      continuationToken: this.#continuationToken,
      sessionId: this.#lastSessionId,
      streamIndex: this.#streamIndex,
    });
  }

  #isDuplicateText(text: string): boolean {
    const now = Date.now();
    for (const [fingerprint, seenAt] of this.#processedTextFingerprints) {
      if (now - seenAt > TEXT_DEDUPE_MS) this.#processedTextFingerprints.delete(fingerprint);
    }
    const fingerprint = textFingerprint(text);
    if (fingerprint.length === 0) return false;
    if (this.#processedTextFingerprints.has(fingerprint)) return true;
    this.#processedTextFingerprints.set(fingerprint, now);
    if (this.#processedTextFingerprints.size > MAX_TRACKED_ITEMS) {
      const oldest = this.#processedTextFingerprints.keys().next().value;
      if (oldest !== undefined) this.#processedTextFingerprints.delete(oldest);
    }
    return false;
  }

  #fail(message: string): void {
    if (!this.#disposed) this.#emit({ type: "error", data: { message } });
    this.#options.closeSocket(1011, message);
    this.dispose();
  }

  #emit(event: EveToGatewayEvent): void {
    if (this.#disposed && event.type !== "error") return;
    this.#seq += 1;
    this.#options.sendRaw(encodeControlPacket(this.#seq, event));
  }

  #clearSettle(): void {
    if (this.#settleTimer !== undefined) {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = undefined;
    }
  }
}

function isBackchannel(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[.!?,]+$/u, "")
    .trim();
  return BACKCHANNELS.has(normalized);
}

function createStateKey(auth: SessionAuthContext, voiceSessionId: string): string {
  return ["voice-control", auth.authenticator, auth.principalType, auth.principalId, voiceSessionId]
    .map(encodeStateKeyPart)
    .join(":");
}

function createStableContinuationToken(auth: SessionAuthContext, voiceSessionId: string): string {
  return createStateKey(auth, voiceSessionId);
}

function encodeStateKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function textFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}
