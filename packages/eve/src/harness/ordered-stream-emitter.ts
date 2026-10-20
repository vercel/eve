import { eventsOf } from "#harness/publication.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ProgressOf } from "#protocol/session-events/facts.js";
import type { HarnessEmitFn } from "#harness/types.js";

type AppendStreamEvent = ProgressOf<"content.delta"> | ProgressOf<"call.input">;

const MAX_PENDING_EVENTS = 64;
const MAX_PENDING_DELTA_CHARACTERS = 64 * 1024;

interface PendingEmission {
  deltaCharacters: number;
  deltaParts?: string[];
  event: SessionEvent;
  /** A commit of several events, emitted together and never merged. */
  commit?: readonly SessionEvent[];
  messages?: readonly import("ai").ModelMessage[];
  sourceEvents: number;
}

interface OrderedStreamEmitter {
  closeAndDrain(): Promise<void>;
  /** Emits one streamed event, merged with adjacent deltas, or one commit, which is a barrier. */
  emit: HarnessEmitFn;
  readonly failureSignal: AbortSignal;
}

/**
 * Decouples model-stream consumption from the durable event sink while
 * preserving FIFO dispatch. Adjacent append events and same-call tool partials
 * waiting behind the active write are folded together; every other event
 * remains an ordering barrier.
 * Coalescing before the durable writer keeps one Workflow chunk per emitted
 * event, so event-count reconnect cursors remain aligned with chunk indexes.
 */
export function createOrderedStreamEmitter(
  emitFn: HarnessEmitFn,
  options: { readonly maxPendingEvents?: number } = {},
): OrderedStreamEmitter {
  const maxPendingEvents = options.maxPendingEvents ?? MAX_PENDING_EVENTS;
  if (!Number.isInteger(maxPendingEvents) || maxPendingEvents < 1) {
    throw new RangeError("maxPendingEvents must be a positive integer.");
  }

  const pending: PendingEmission[] = [];
  const capacityWaiters = new Set<() => void>();
  const idleWaiters = new Set<() => void>();
  let closeRequested = false;
  let pendingDeltaCharacters = 0;
  let pendingSourceEvents = 0;
  let failure: unknown;
  let failed = false;
  let pumping = false;
  const failureController = new AbortController();

  const throwIfFailed = (): void => {
    if (failed) throw failure;
  };

  const settleIdleWaiters = (): void => {
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const hasCapacity = (): boolean =>
    pendingSourceEvents < maxPendingEvents && pendingDeltaCharacters < MAX_PENDING_DELTA_CHARACTERS;

  const settleCapacityWaiters = (): void => {
    if (!hasCapacity()) return;
    for (const resolve of capacityWaiters) resolve();
    capacityWaiters.clear();
  };

  const pump = async (): Promise<void> => {
    if (pumping || failed) return;
    pumping = true;

    while (pending.length > 0) {
      const next = pending.shift();
      if (next === undefined) break;
      pendingDeltaCharacters -= next.deltaCharacters;
      pendingSourceEvents -= next.sourceEvents;
      settleCapacityWaiters();

      try {
        await emitFn(next.commit ?? materializeEvent(next), next.messages);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
          failureController.abort(error);
        }
        pending.length = 0;
        pendingDeltaCharacters = 0;
        pendingSourceEvents = 0;
        settleCapacityWaiters();
        break;
      }
    }

    pumping = false;
    settleIdleWaiters();
  };

  const waitForIdle = async (): Promise<void> => {
    if (!pumping && pending.length === 0) {
      throwIfFailed();
      return;
    }

    await new Promise<void>((resolve) => {
      idleWaiters.add(resolve);
    });
    throwIfFailed();
  };

  const waitForCapacity = async (): Promise<void> => {
    if (hasCapacity()) return;
    await new Promise<void>((resolve) => {
      capacityWaiters.add(resolve);
    });
    throwIfFailed();
  };

  return {
    async closeAndDrain() {
      closeRequested = true;
      void pump();
      await waitForIdle();
    },
    async emit(publication, messages) {
      throwIfFailed();
      if (closeRequested) {
        throw new TypeError("Cannot emit after the ordered stream emitter has closed.");
      }
      const events = eventsOf(publication);
      const event = events[0];
      if (event === undefined) return;
      if (events.length > 1) {
        pending.push({
          commit: events,
          deltaCharacters: 0,
          event,
          messages,
          sourceEvents: events.length,
        });
        pendingSourceEvents += events.length;
        void pump();
        if (pendingSourceEvents >= maxPendingEvents) await waitForCapacity();
        throwIfFailed();
        return;
      }

      const lastIndex = pending.length - 1;
      const last = pending[lastIndex];
      const delta = appendDelta(event);
      if (
        last === undefined ||
        last.commit !== undefined ||
        !mergeAdjacentEmissions(last, event, messages)
      ) {
        pending.push({
          deltaCharacters: delta?.length ?? 0,
          event,
          messages,
          sourceEvents: 1,
        });
      } else {
        last.deltaCharacters += delta?.length ?? 0;
        last.sourceEvents += 1;
      }
      pendingDeltaCharacters += delta?.length ?? 0;
      pendingSourceEvents += 1;

      void pump();

      if (
        pendingSourceEvents >= maxPendingEvents ||
        pendingDeltaCharacters >= MAX_PENDING_DELTA_CHARACTERS
      ) {
        await waitForCapacity();
      }
      throwIfFailed();
    },
    failureSignal: failureController.signal,
  };
}

function mergeAdjacentEmissions(
  left: PendingEmission,
  right: SessionEvent,
  messages: readonly import("ai").ModelMessage[] | undefined,
): boolean {
  const leftAppendKey = appendKey(left.event);
  const rightAppendKey = appendKey(right);
  if (leftAppendKey !== undefined || rightAppendKey !== undefined) {
    if (
      leftAppendKey === undefined ||
      leftAppendKey !== rightAppendKey ||
      !isAppendEvent(left.event) ||
      !isAppendEvent(right)
    ) {
      return false;
    }
    // The first record announces the entity; merged deltas keep its announcement.
    left.deltaParts ??= [appendDelta(left.event)];
    left.deltaParts.push(appendDelta(right));
    left.messages = messages;
    return true;
  }

  if (left.event.type === "call.progress" && right.type === "call.progress") {
    if (left.event.data.callId !== right.data.callId) return false;
    left.event = right;
    left.messages = messages;
    return true;
  }

  return false;
}

function appendKey(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "content.delta":
      return `${event.type}:${event.data.partId}`;
    case "call.input":
      return `${event.type}:${event.data.callId}`;
    default:
      return undefined;
  }
}

function isAppendEvent(event: SessionEvent): event is AppendStreamEvent {
  return appendKey(event) !== undefined;
}

function appendDelta(event: AppendStreamEvent): string;
function appendDelta(event: SessionEvent): string | undefined;
function appendDelta(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "content.delta":
    case "call.input":
      return event.data.delta;
    default:
      return undefined;
  }
}

function materializeEvent(emission: PendingEmission): SessionEvent {
  if (emission.deltaParts === undefined) return emission.event;
  const { event } = emission;
  if (event.type === "content.delta" || event.type === "call.input") {
    return {
      ...event,
      data: { ...event.data, delta: emission.deltaParts.join("") },
    } as SessionEvent;
  }
  return event;
}
