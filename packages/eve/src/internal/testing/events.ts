import type { UnstampedMessageStreamEvent, MessageStreamEvent } from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent } from "#protocol/message.js";

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
   * Reads stream lines until the next turn-boundary event (`session.waiting`,
   * `session.completed`, or `session.failed`) and returns every event
   * observed in that turn.
   */
  nextTurn(): Promise<MessageStreamEvent[]>;
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
  const state: StreamState = { buffer: "" };
  const decoder = options.decoder ?? new TextDecoder();
  let disposed = false;

  return {
    async nextTurn() {
      if (disposed) {
        throw new Error("CapturedTurnStream: stream already disposed.");
      }

      return await readUntilBoundary(reader, state, decoder);
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
 * Asserts that `events` contains one contiguous occurrence of `types`, in
 * order, without intervening matches.
 *
 * Preserves the spirit of polling-free assertion: returns boolean so the
 * caller composes with vitest expectations (`expect(...).toBe(true)`), no
 * timing or retries involved.
 */
export function containsEventSequence(
  events: readonly UnstampedMessageStreamEvent[],
  types: readonly UnstampedMessageStreamEvent["type"][],
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
export function filterEventsByType<T extends UnstampedMessageStreamEvent["type"]>(
  events: readonly UnstampedMessageStreamEvent[],
  type: T,
): Array<Extract<UnstampedMessageStreamEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<UnstampedMessageStreamEvent, { type: T }> => event.type === type,
  );
}

/**
 * Options accepted by {@link captureTurnEvents} and
 * {@link captureTurnSequence}.
 */
export interface CaptureTurnEventsOptions {
  /**
   * Text decoder used to convert stream bytes into UTF-8 strings. Defaults
   * to a fresh `TextDecoder`. Tests rarely need to override this.
   */
  readonly decoder?: InstanceType<typeof TextDecoder>;
}

interface StreamState {
  buffer: string;
}

async function readUntilBoundary(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: StreamState,
  decoder: InstanceType<typeof TextDecoder>,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      throw new Error("Workflow stream closed before reaching a turn boundary.");
    }

    state.buffer += decoder.decode(value);

    for (
      let newlineIndex = state.buffer.indexOf("\n");
      newlineIndex !== -1;
      newlineIndex = state.buffer.indexOf("\n")
    ) {
      const line = state.buffer.slice(0, newlineIndex).trim();
      state.buffer = state.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const event = JSON.parse(line) as MessageStreamEvent;
      events.push(event);

      if (isCurrentTurnBoundaryEvent(event)) {
        return events;
      }
    }
  }
}

/**
 * Stamps a constructed event so a fixture satisfies the stamped stream
 * contract without a real emit seam. Ids are sequential and readable; use
 * `stampMessageStreamEvent` when a test asserts on real id format.
 */
export function stampTestEvent(event: UnstampedMessageStreamEvent, index = 0): MessageStreamEvent {
  return {
    ...event,
    meta: {
      at: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
      id: `evt_test_${String(index).padStart(4, "0")}`,
    },
  };
}

/** Stamps every event in a fixture list. See {@link stampTestEvent}. */
export function stampTestEvents(
  events: readonly UnstampedMessageStreamEvent[],
): MessageStreamEvent[] {
  return events.map((event, index) => stampTestEvent(event, index));
}
