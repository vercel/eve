import type { Runtime } from "#channel/types.js";
import { createLegacyEventTranslator } from "#execution/legacy-events.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { isProgressType } from "#protocol/session-events/catalog.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import {
  foldSession,
  initialSessionProjection,
  pruneSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { cloneView, emptySessionView, foldLine } from "#protocol/session-projection/fold.js";

// A session handle's event stream, as authored code reads it: the v26 events the stored facts
// stand for, counted in events. It reads the session from its first line, folding as the server
// did when it wrote each line, so each line translates as it did for the session's hooks.

type FactSource = Pick<Runtime, "getEventStream" | "getStreamTailIndex">;

/** The session's v26 events from event `startIndex` on; a negative index counts from the tail. */
export async function legacyEventStream(
  runtime: FactSource,
  sessionId: string,
  startIndex = 0,
): Promise<ReadableStream<MessageStreamEvent>> {
  const skip =
    startIndex >= 0
      ? startIndex
      : Math.max(0, (await legacyTailIndex(runtime, sessionId)) + 1 + startIndex);
  const source = await runtime.getEventStream(sessionId, { startIndex: 0 });
  const reader = source.getReader();
  const lines = translatedLines(sessionId);
  let skipped = 0;
  return new ReadableStream<MessageStreamEvent>({
    async pull(controller) {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          for (const event of lines.flush()) {
            if (skipped < skip) skipped += 1;
            else controller.enqueue(event);
          }
          controller.close();
          return;
        }
        const translated = lines.push(next.value);
        let enqueued = false;
        for (const event of translated) {
          if (skipped < skip) {
            skipped += 1;
            continue;
          }
          controller.enqueue(event);
          enqueued = true;
        }
        if (enqueued) return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** The index of the session's last v26 event, or `-1` before the first. */
export async function legacyTailIndex(runtime: FactSource, sessionId: string): Promise<number> {
  const tailLine = await runtime.getStreamTailIndex(sessionId);
  if (tailLine < 0) return -1;
  const source = await runtime.getEventStream(sessionId, { startIndex: 0 });
  const reader = source.getReader();
  const lines = translatedLines(sessionId);
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        count += lines.flush().length;
        return count - 1;
      }
      count += lines.push(next.value).length;
      const { endOfLine, position } = next.value.meta;
      if (position.line >= tailLine && endOfLine !== false) return count - 1;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Regroups events into their lines, folds each, and translates it once it is whole. */
function translatedLines(sessionId: string): {
  push(event: SessionStreamEvent): readonly MessageStreamEvent[];
  flush(): readonly MessageStreamEvent[];
} {
  const translator = createLegacyEventTranslator();
  let projection: SessionProjection = initialSessionProjection();
  let view = emptySessionView();
  let pending: SessionStreamEvent[] = [];
  const translate = (events: readonly SessionStreamEvent[]): readonly MessageStreamEvent[] => {
    const first = events[0];
    if (first === undefined) return [];
    const position = first.meta.position.line;
    const before: SessionProjection = { ...projection, view };
    for (const event of events) {
      projection = foldSession(projection, event);
      if (event.type === "turn.settled") projection = pruneSessionProjection(projection);
    }
    const line: StoredLine =
      events.length === 1 && isProgressType(first.type)
        ? { progress: first }
        : { at: first.meta.at, facts: events };
    const next = cloneView(view);
    foldLine(next, line, position, { retention: "operational" });
    view = next;
    projection = { ...projection, position: position + 1 };
    const after: SessionProjection = { ...projection, view };
    return translator
      .translate({ after, at: first.meta.at, before, events, position }, { sessionId })
      .flat();
  };
  return {
    push(event) {
      const last = pending.at(-1);
      const out: MessageStreamEvent[] = [];
      if (last !== undefined && last.meta.position.line !== event.meta.position.line) {
        out.push(...translate(pending));
        pending = [];
      }
      pending.push(event);
      if (event.meta.endOfLine !== false) {
        out.push(...translate(pending));
        pending = [];
      }
      return out;
    },
    flush() {
      const out = translate(pending);
      pending = [];
      return out;
    },
  };
}
