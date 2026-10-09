import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { TurnSegment } from "#client/session-utils.js";
import { createSessionContract } from "#internal/testing/session-contract.js";
import { createEventReader, linesOf } from "#protocol/session-lines.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";

/**
 * Minimal, duck-typed handle to one workflow `Run`'s readable stream.
 *
 * The real `Run` is a platform-specific object exposed by Workflow core;
 * we only depend on `readable` and `cancel` so the helper stays usable from
 * any tier without importing workflow types.
 */
export interface WorkflowRunHandle {
  readonly readable: ReadableStream<Uint8Array>;
  cancel(): Promise<void>;
}

/**
 * Stateful capture handle returned by {@link captureTurnEvents}.
 *
 * Holds the underlying reader and decode buffer across calls so
 * multi-turn scripts (e.g. resume-then-read) observe one contiguous
 * stream. Callers must invoke `dispose()` when finished to release the
 * reader lock — wrap the capture in a `try/finally` around the run.
 */
export interface CapturedTurnStream {
  /**
   * Reads stream lines until the next turn boundary (`session.waiting`,
   * `session.completed`, `session.failed`, or a `turn.waiting` while an input
   * request is unanswered) and returns every event observed in that segment.
   */
  nextTurn(): Promise<SessionStreamEvent[]>;
  /**
   * Reads stream lines until `matches` accepts an event, such as the
   * `turn.waiting` an open turn emits while it parks, and returns every event
   * read through that one.
   */
  nextUntil(matches: (event: SessionStreamEvent) => boolean): Promise<SessionStreamEvent[]>;
  /** Releases the reader lock on the underlying `ReadableStream`. */
  dispose(): void;
}

/**
 * Opens a reader on `run.readable` and returns a stateful
 * {@link CapturedTurnStream}. Subsequent `nextTurn()` calls observe the
 * same stream, so resume-driven multi-turn tests stay deterministic.
 *
 * Callers are responsible for calling `dispose()` and `run.cancel()` when
 * they are finished with the run.
 */
export function captureTurnEvents(
  run: WorkflowRunHandle,
  options: CaptureTurnEventsOptions = {},
): CapturedTurnStream {
  const reader = run.readable.getReader();
  const state: StreamState = {
    buffer: "",
    lines: createEventReader(),
    pending: [],
    position: 0,
  };
  const decoder = options.decoder ?? new TextDecoder();
  let disposed = false;
  // Every stream a test reads is held to the session contract readers rely on.
  const contract = createSessionContract();
  let index = 0;

  const readUntil = async (matches: (event: SessionStreamEvent) => boolean) => {
    if (disposed) {
      throw new Error("CapturedTurnStream: stream already disposed.");
    }

    return await readUntilMatch(reader, state, decoder, (event) => {
      const [violation] = contract.observe(event);
      if (violation !== undefined) {
        throw new Error(
          `Session stream contract (${violation.rule}) at event ${index}: ${violation.message}`,
        );
      }
      index += 1;
      return matches(event);
    });
  };

  return {
    async nextTurn() {
      const segment = new TurnSegment();
      return await readUntil((event) => segment.observe(event));
    },
    async nextUntil(matches) {
      return await readUntil(matches);
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      reader.releaseLock();
    },
  };
}

/**
 * Reads the run's first turn, then cancels the parked session. Returns the
 * turn's final assistant message.
 */
export async function readFirstTurnReply(run: WorkflowRunHandle): Promise<string | null> {
  const stream = captureTurnEvents(run);
  try {
    const turn = await stream.nextTurn();
    return filterEventsByType(turn, "message.completed").at(-1)?.data.message ?? null;
  } finally {
    stream.dispose();
    await run.cancel();
  }
}

/**
 * Asserts that `events` contains one contiguous occurrence of `types`, in
 * order, without intervening matches.
 *
 * Preserves the spirit of polling-free assertion: returns boolean so the
 * caller composes with vitest expectations (`expect(...).toBe(true)`), no
 * timing or retries involved.
 */
export function containsEventSequence(
  events: readonly SessionEvent[],
  types: readonly SessionEvent["type"][],
): boolean {
  if (types.length === 0) {
    return true;
  }

  let cursor = 0;

  for (const event of events) {
    if (event.type === types[cursor]) {
      cursor += 1;

      if (cursor === types.length) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns only the events whose `type` matches one of the provided
 * discriminants. Handy for assertion blocks that only care about a
 * subset of the full turn envelope.
 */
export function filterEventsByType<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Array<Extract<SessionEvent, { type: T }>> {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

/**
 * Options accepted by {@link captureTurnEvents} and
 * {@link captureTurnSequence}.
 */
interface CaptureTurnEventsOptions {
  /**
   * Text decoder used to convert stream bytes into UTF-8 strings. Defaults
   * to a fresh `TextDecoder`. Tests rarely need to override this.
   */
  readonly decoder?: InstanceType<typeof TextDecoder>;
}

interface StreamState {
  buffer: string;
  /** The position of the next stored line. */
  position: number;
  /** Events of a line already read that the last call stopped before. */
  pending: SessionStreamEvent[];
  readonly lines: ReturnType<typeof createEventReader>;
}

async function readUntilMatch(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: StreamState,
  decoder: InstanceType<typeof TextDecoder>,
  matches: (event: SessionStreamEvent) => boolean,
): Promise<SessionStreamEvent[]> {
  const events: SessionStreamEvent[] = [];

  while (true) {
    while (state.pending.length > 0) {
      const event = state.pending.shift() as SessionStreamEvent;
      events.push(event);
      if (matches(event)) return events;
    }
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = state.buffer.slice(0, newlineIndex).trim();
      state.buffer = state.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      const value: unknown = JSON.parse(line);
      const position = state.position;
      state.position += 1;
      if (isStoredLine(value)) state.pending.push(...state.lines.read(value, position));
      continue;
    }

    const { done, value } = await reader.read();
    if (done) {
      throw new Error("Workflow stream closed before reaching a turn boundary.");
    }
    state.buffer += decoder.decode(value, { stream: true });
  }
}

/**
 * Stamps a constructed event so a fixture satisfies the stamped stream
 * contract without a real emit seam. Ids are sequential and readable.
 */
export function stampTestEvent(event: SessionEvent, index = 0): SessionStreamEvent {
  return {
    ...event,
    meta: {
      at: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
      id: `evt_test_${String(index).padStart(4, "0")}`,
    },
  };
}

/** Stamps every event in a fixture list. See {@link stampTestEvent}. */
export function stampTestEvents(events: readonly SessionEvent[]): SessionStreamEvent[] {
  return events.map((event, index) => stampTestEvent(event, index));
}

/** Token usage a session reports in tests that build session events without caring about its value. */
export const TEST_USAGE = {
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  costUsd: 0.0042,
  inputTokens: 1200,
  outputTokens: 150,
};

/**
 * Encodes events as the stored lines a stream route serves: each event on its own line, so a
 * fixture's event indexes are its positions. Pass `deliveryIds` to attribute every event.
 */
export function encodeTestLine(event: SessionEvent, deliveryIds?: readonly string[]): string {
  return linesOf([event], new Date(Date.UTC(2026, 0, 1)).toISOString(), deliveryIds)
    .map((line) => `${JSON.stringify(line)}\n`)
    .join("");
}
