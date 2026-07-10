import type {
  HandleMessageStreamEvent,
  MessageAppendedStreamEvent,
  ReasoningAppendedStreamEvent,
} from "#protocol/message.js";
import type { HarnessEmitFn } from "#harness/types.js";

const MAX_PENDING_EVENTS = 64;
const MAX_PENDING_DELTA_CHARACTERS = 64 * 1024;

interface PendingEmission {
  deltaCharacters: number;
  deltaParts?: string[];
  event: HandleMessageStreamEvent;
  messages?: readonly import("ai").ModelMessage[];
}

interface OrderedStreamEmitter {
  drain(): Promise<void>;
  emit: HarnessEmitFn;
}

/**
 * Decouples model-stream consumption from the durable event sink while
 * preserving FIFO dispatch. Adjacent append events waiting behind the active
 * write are folded together; every other event remains an ordering barrier.
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
  const idleWaiters = new Set<() => void>();
  let pendingDeltaCharacters = 0;
  let failure: unknown;
  let failed = false;
  let pumping = false;

  const throwIfFailed = (): void => {
    if (failed) throw failure;
  };

  const settleIdleWaiters = (): void => {
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const pump = async (): Promise<void> => {
    if (pumping || failed) return;
    pumping = true;

    while (pending.length > 0) {
      const next = pending.shift();
      if (next === undefined) break;
      pendingDeltaCharacters -= next.deltaCharacters;

      try {
        await emitFn(materializeEvent(next), next.messages);
      } catch (error) {
        failure = error;
        failed = true;
        pending.length = 0;
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

  return {
    async drain() {
      void pump();
      await waitForIdle();
    },
    async emit(event, messages) {
      throwIfFailed();

      const lastIndex = pending.length - 1;
      const last = pending[lastIndex];
      const delta = appendDelta(event);
      if (last === undefined || !mergeAdjacentAppends(last, event, messages)) {
        pending.push({
          deltaCharacters: delta?.length ?? 0,
          event,
          messages,
        });
      } else {
        last.deltaCharacters += delta?.length ?? 0;
      }
      pendingDeltaCharacters += delta?.length ?? 0;

      void pump();

      if (
        pending.length >= maxPendingEvents ||
        pendingDeltaCharacters >= MAX_PENDING_DELTA_CHARACTERS
      ) {
        await waitForIdle();
      }
      throwIfFailed();
    },
  };
}

function mergeAdjacentAppends(
  left: PendingEmission,
  right: HandleMessageStreamEvent,
  messages: readonly import("ai").ModelMessage[] | undefined,
): boolean {
  if (left.event.type === "message.appended" && right.type === "message.appended") {
    if (!sameCoordinates(left.event, right)) return false;
    left.deltaParts ??= [left.event.data.messageDelta];
    left.deltaParts.push(right.data.messageDelta);
    left.event = right;
    left.messages = messages;
    return true;
  }

  if (left.event.type === "reasoning.appended" && right.type === "reasoning.appended") {
    if (!sameCoordinates(left.event, right)) return false;
    left.deltaParts ??= [left.event.data.reasoningDelta];
    left.deltaParts.push(right.data.reasoningDelta);
    left.event = right;
    left.messages = messages;
    return true;
  }

  return false;
}

function appendDelta(event: HandleMessageStreamEvent): string | undefined {
  if (event.type === "message.appended") return event.data.messageDelta;
  if (event.type === "reasoning.appended") return event.data.reasoningDelta;
  return undefined;
}

function materializeEvent(emission: PendingEmission): HandleMessageStreamEvent {
  if (emission.deltaParts === undefined) return emission.event;

  if (emission.event.type === "message.appended") {
    return {
      data: {
        ...emission.event.data,
        messageDelta: emission.deltaParts.join(""),
      },
      type: "message.appended",
    };
  }

  if (emission.event.type === "reasoning.appended") {
    return {
      data: {
        ...emission.event.data,
        reasoningDelta: emission.deltaParts.join(""),
      },
      type: "reasoning.appended",
    };
  }

  return emission.event;
}

function sameCoordinates(
  left: MessageAppendedStreamEvent | ReasoningAppendedStreamEvent,
  right: MessageAppendedStreamEvent | ReasoningAppendedStreamEvent,
): boolean {
  return (
    left.data.sequence === right.data.sequence &&
    left.data.stepIndex === right.data.stepIndex &&
    left.data.turnId === right.data.turnId
  );
}
