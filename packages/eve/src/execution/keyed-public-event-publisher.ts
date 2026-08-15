import { createHash } from "node:crypto";

import {
  appendKeyedStreamChunk,
  getStepMetadata,
  KeyedStreamAppendUnavailableError,
} from "#compiled/@workflow/core/index.js";
import {
  getDeserializeStream,
  getSerializeStream,
} from "#compiled/@workflow/core/serialization.js";
import {
  encodeMessageStreamEvent,
  type MessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

const STREAM_NAME_SYMBOL = Symbol.for("WORKFLOW_STREAM_NAME");
const STREAM_RUN_ID_SYMBOL = Symbol.for("WORKFLOW_STREAM_SERVER_RUN_ID");
const decoder = new TextDecoder();

export class KeyedPublicEventCompatibilityError extends Error {
  constructor() {
    super("Keyed public event publication requires a Workflow v1 keyed stream.");
    this.name = "KeyedPublicEventCompatibilityError";
  }
}

export class KeyedPublicEventDivergenceError extends Error {
  constructor() {
    super("Keyed public event receipt diverged from the current logical event.");
    this.name = "KeyedPublicEventDivergenceError";
  }
}

interface StreamIdentity {
  readonly name: string;
  readonly runId: string;
}

/**
 * Publishes one step's public events through Workflow's canonical keyed receipt.
 * Exact-recovery admission never falls back. Normal beta.34-compatible operation
 * may use the ordinary writer only for the typed pre-commit unavailable result,
 * and waits for that writer before exposing insertion to downstream effects.
 */
export function createKeyedPublicEventPublisher(input: {
  /** Exact-recovery runs must never downgrade a missing keyed receipt. */
  readonly exactRecovery?: boolean;
  readonly parentWritable: WritableStream<Uint8Array>;
  /** The owning step's writer, used only by the non-exact compatibility path. */
  readonly parentWriter?: WritableStreamDefaultWriter<Uint8Array>;
  readonly sessionId: string;
}): {
  publish(event: UnstampedMessageStreamEvent): Promise<{
    readonly event: MessageStreamEvent;
    readonly inserted: boolean;
  }>;
} {
  const { stepId } = getStepMetadata();
  const serialized = getSerializeStream({}, undefined);
  const serializedReader = serialized.readable.getReader();
  const serializedWriter = serialized.writable.getWriter();
  let ordinal = 0;
  let serializationTail = Promise.resolve();
  let keyedAppendAvailable = true;

  return {
    async publish(event) {
      const stream = resolveStreamIdentity(input.parentWritable);
      const currentOrdinal = ordinal++;
      const semanticDigest = digest(event);
      const stamped = stampMessageStreamEvent(event);
      const encoded = encodeMessageStreamEvent(stamped);
      const chunk = await serializePublicEvent(
        encoded,
        serializedReader,
        serializedWriter,
        serializationTail,
        (next) => {
          serializationTail = next;
        },
      );
      if (!keyedAppendAvailable)
        return await appendOrdinaryPublicEvent(input.parentWriter, encoded, stamped);

      let receipt;
      try {
        receipt = await appendKeyedStreamChunk(stream.runId, stream.name, {
          chunk,
          idempotencyKey: `eve-public-event/v1/${input.sessionId}/${stepId}/${currentOrdinal}`,
          semanticDigest,
        });
      } catch (error) {
        if (input.exactRecovery === true || !(error instanceof KeyedStreamAppendUnavailableError)) throw error;
        keyedAppendAvailable = false;
        return await appendOrdinaryPublicEvent(input.parentWriter, encoded, stamped);
      }
      const canonical = await decodeCanonicalEvent(receipt.canonicalChunk);
      if (digest(withoutMeta(canonical)) !== semanticDigest) {
        throw new KeyedPublicEventDivergenceError();
      }
      return { event: canonical, inserted: receipt.inserted };
    },
  };
}

async function appendOrdinaryPublicEvent(
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
  encoded: Uint8Array,
  event: MessageStreamEvent,
): Promise<{ readonly event: MessageStreamEvent; readonly inserted: true }> {
  if (writer === undefined) throw new KeyedPublicEventCompatibilityError();
  // Preserve the normal writer's success boundary: a pending or rejected write
  // cannot be reported as an inserted event.
  await writer.write(encoded);
  return { event, inserted: true };
}

async function serializePublicEvent(
  event: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  prior: Promise<void>,
  setTail: (next: Promise<void>) => void,
): Promise<Uint8Array> {
  let resolveTail!: () => void;
  let rejectTail!: (error: unknown) => void;
  const nextTail = new Promise<void>((resolve, reject) => {
    resolveTail = resolve;
    rejectTail = reject;
  });
  setTail(nextTail);

  await prior;
  try {
    const read = reader.read();
    await writer.write(event);
    const result = await read;
    if (result.done || result.value === undefined) {
      throw new KeyedPublicEventCompatibilityError();
    }
    resolveTail();
    return result.value;
  } catch (error) {
    rejectTail(error);
    throw error;
  }
}

function resolveStreamIdentity(stream: WritableStream<Uint8Array>): StreamIdentity {
  const tagged = stream as WritableStream<Uint8Array> & Record<symbol, unknown>;
  const name = tagged[STREAM_NAME_SYMBOL];
  const runId = tagged[STREAM_RUN_ID_SYMBOL];
  if (typeof name !== "string" || typeof runId !== "string") {
    throw new KeyedPublicEventCompatibilityError();
  }
  return { name, runId };
}

async function decodeCanonicalEvent(chunk: Uint8Array): Promise<MessageStreamEvent> {
  try {
    return parseCanonicalEvent(chunk);
  } catch {
    try {
      const deserialize = getDeserializeStream({}, undefined);
      const reader = deserialize.readable.getReader();
      const writer = deserialize.writable.getWriter();
      const read = reader.read();
      await writer.write(chunk);
      const result = await read;
      if (result.done || !(result.value instanceof Uint8Array)) {
        throw new Error("missing canonical stream payload");
      }
      return parseCanonicalEvent(result.value);
    } catch {
      throw new KeyedPublicEventDivergenceError();
    }
  }
}

function parseCanonicalEvent(chunk: Uint8Array): MessageStreamEvent {
  const event = JSON.parse(decoder.decode(chunk).trim()) as MessageStreamEvent;
  if (
    event.meta === undefined ||
    typeof event.meta.at !== "string" ||
    typeof event.meta.id !== "string"
  ) {
    throw new Error("missing canonical event metadata");
  }
  return event;
}

function withoutMeta(event: MessageStreamEvent): UnstampedMessageStreamEvent {
  const { meta: _meta, ...unstamped } = event;
  return unstamped;
}

function digest(event: UnstampedMessageStreamEvent): string {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
