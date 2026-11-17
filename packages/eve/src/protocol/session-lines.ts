import { isFactType, isProgressType } from "#protocol/session-events/catalog.js";
import type { CommitLine, ProgressLine, StoredLine } from "#protocol/session-events/envelope.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

export function isKnownRecordType(type: unknown): boolean {
  return isFactType(type) || isProgressType(type);
}

export function linesOf(
  events: readonly SessionEvent[],
  at: string,
): StoredLine<SessionEvent, SessionEvent>[] {
  const lines: StoredLine<SessionEvent, SessionEvent>[] = [];
  let facts: SessionEvent[] = [];
  const flush = () => {
    if (facts.length === 0) return;
    lines.push({ at, facts } satisfies CommitLine<SessionEvent>);
    facts = [];
  };
  for (const event of events) {
    if (isProgressType(event.type)) {
      flush();
      lines.push({ progress: event } satisfies ProgressLine<SessionEvent>);
    } else {
      facts.push(event);
    }
  }
  flush();
  return lines;
}

export function eventsOfLine(
  line: StoredLine,
  position: number,
  progressAt: string,
): SessionStreamEvent[] {
  const records: readonly unknown[] = "facts" in line ? line.facts : [line.progress];
  const at = "facts" in line ? line.at : progressAt;
  const events: SessionStreamEvent[] = [];
  records.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object") return;
    const record = raw as SessionEvent;
    if (!isKnownRecordType(record.type)) return;
    events.push({
      ...record,
      meta: { at, endOfLine: false, position: { index, line: position } },
    } as SessionStreamEvent);
  });
  const last = events.at(-1);
  if (last !== undefined) {
    events[events.length - 1] = { ...last, meta: { ...last.meta, endOfLine: true } };
  }
  return events;
}

export function createEventReader(progressAt = new Date(0).toISOString()): {
  read(line: StoredLine, position: number): SessionStreamEvent[];
} {
  let lastAt = progressAt;
  return {
    read(line, position) {
      if ("facts" in line) lastAt = line.at;
      return eventsOfLine(line, position, lastAt);
    },
  };
}
