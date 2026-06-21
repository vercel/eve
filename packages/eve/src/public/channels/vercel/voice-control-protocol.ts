/**
 * Wire protocol for the Gateway ↔ Eve realtime voice control socket
 * (`eve-voice-control.v1`). Both directions use the same envelope; this module
 * is Eve's mirror of the Gateway client in
 * `ai-gateway/lib/gateway/websocket/eve-voice-control.ts`.
 */

export const EVE_VOICE_CONTROL_PROTOCOL = "eve-voice-control.v1";

/**
 * Per-session capability hints the Gateway advertises in `session.opened`. Eve
 * tunes behavior to them: skip the spoken readout when `output.audio` is false
 * (run the durable turn anyway), skip `response.cancel` when `output.cancel` is
 * false, and never expect partial transcripts when `input.transcript.partial`
 * is false. Absent values default permissive for backward compatibility.
 */
export interface RealtimeControlCapabilities {
  readonly "input.transcript.final": boolean;
  readonly "input.transcript.partial": boolean;
  readonly "input.speech.started": boolean;
  readonly "input.interrupted": boolean;
  readonly "output.audio": boolean;
  readonly "output.cancel": boolean;
  readonly "output.exactReadout": boolean;
}

/** Speech-engine descriptor advertised by the Gateway in `session.opened`. */
export interface RealtimeControlEngine {
  readonly provider: string;
  readonly model: string;
  readonly protocol: string;
  readonly capabilities: RealtimeControlCapabilities;
}

/** Permissive defaults used when the Gateway omits a capability (or all of `engine`). */
export const DEFAULT_CONTROL_CAPABILITIES: RealtimeControlCapabilities = {
  "input.transcript.final": true,
  "input.transcript.partial": false,
  "input.speech.started": true,
  "input.interrupted": true,
  "output.audio": true,
  "output.cancel": true,
  "output.exactReadout": false,
};

/** Events AI Gateway sends to Eve. */
export type GatewayToEveEvent =
  | {
      readonly type: "session.opened";
      readonly data: { readonly sessionId: string; readonly engine?: RealtimeControlEngine };
    }
  | { readonly type: "input.speech.started"; readonly data: { readonly itemId?: string } }
  | { readonly type: "input.speech.stopped"; readonly data: { readonly itemId?: string } }
  | { readonly type: "input.interrupted"; readonly data: Record<string, never> }
  | {
      readonly type: "input.transcript.final";
      readonly data: { readonly text: string; readonly itemId?: string };
    }
  | {
      readonly type: "session.stats";
      readonly data: {
        readonly durationMs: number;
        readonly responseDeltaCount: number;
        readonly transcriptFinalCount: number;
      };
    }
  | { readonly type: "session.closed"; readonly data: { readonly reason: string } }
  | { readonly type: "error"; readonly data: { readonly message: string } };

/** Events Eve sends to AI Gateway. */
export type EveToGatewayEvent =
  | { readonly type: "session.ready"; readonly data?: Record<string, never> }
  // `turnId` correlates a turn's lifecycle frames so the Gateway can drop frames
  // from a superseded turn (after barge-in) by id rather than relying on ordering.
  | { readonly type: "turn.started"; readonly data: { readonly turnId: string } }
  | {
      readonly type: "response.delta";
      readonly data: { readonly text: string; readonly turnId: string };
    }
  | { readonly type: "response.done"; readonly data: { readonly turnId: string } }
  | { readonly type: "response.cancel"; readonly data: { readonly turnId: string } }
  | {
      readonly type: "error";
      readonly data: { readonly code?: string; readonly message?: string };
    };

interface ControlPacket {
  readonly v: 1;
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Serializes an Eve→Gateway event into a wire packet string. */
export function encodeControlPacket(seq: number, event: EveToGatewayEvent): string {
  const packet: ControlPacket = {
    v: 1,
    id: `evt_${crypto.randomUUID()}`,
    seq,
    type: event.type,
    data: (event.data ?? {}) as Record<string, unknown>,
  };
  return JSON.stringify(packet);
}

/** Parses an inbound Gateway→Eve wire packet, or `null` when malformed. */
export function parseControlPacket(raw: string): GatewayToEveEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.v !== 1 || typeof parsed.type !== "string") return null;
  const data = isRecord(parsed.data) ? parsed.data : {};

  switch (parsed.type) {
    case "session.opened": {
      if (typeof data.sessionId !== "string") return null;
      const openedData: { sessionId: string; engine?: RealtimeControlEngine } = {
        sessionId: data.sessionId,
      };
      const engine = parseEngine(data.engine);
      if (engine !== undefined) openedData.engine = engine;
      return { type: "session.opened", data: openedData };
    }
    case "input.speech.started":
      return { type: "input.speech.started", data: itemIdOnly(data) };
    case "input.speech.stopped":
      return { type: "input.speech.stopped", data: itemIdOnly(data) };
    case "input.interrupted":
      return { type: "input.interrupted", data: {} };
    case "input.transcript.final":
      return typeof data.text === "string"
        ? { type: "input.transcript.final", data: { text: data.text, ...itemIdOnly(data) } }
        : null;
    case "session.stats":
      return {
        type: "session.stats",
        data: {
          durationMs: numberOr(data.durationMs, 0),
          responseDeltaCount: numberOr(data.responseDeltaCount, 0),
          transcriptFinalCount: numberOr(data.transcriptFinalCount, 0),
        },
      };
    case "session.closed":
      return {
        type: "session.closed",
        data: { reason: typeof data.reason === "string" ? data.reason : "unknown" },
      };
    case "error":
      return {
        type: "error",
        data: { message: typeof data.message === "string" ? data.message : "unknown" },
      };
    default:
      return null;
  }
}

function parseEngine(value: unknown): RealtimeControlEngine | undefined {
  if (!isRecord(value)) return undefined;
  const caps = isRecord(value.capabilities) ? value.capabilities : {};
  return {
    provider: typeof value.provider === "string" ? value.provider : "unknown",
    model: typeof value.model === "string" ? value.model : "unknown",
    protocol: typeof value.protocol === "string" ? value.protocol : "unknown",
    capabilities: {
      "input.transcript.final": boolOr(caps["input.transcript.final"], true),
      "input.transcript.partial": boolOr(caps["input.transcript.partial"], false),
      "input.speech.started": boolOr(caps["input.speech.started"], true),
      "input.interrupted": boolOr(caps["input.interrupted"], true),
      "output.audio": boolOr(caps["output.audio"], true),
      "output.cancel": boolOr(caps["output.cancel"], true),
      "output.exactReadout": boolOr(caps["output.exactReadout"], false),
    },
  };
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function itemIdOnly(data: Record<string, unknown>): { itemId?: string } {
  return typeof data.itemId === "string" ? { itemId: data.itemId } : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
