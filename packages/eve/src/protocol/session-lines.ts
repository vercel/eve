// How published events become stored lines, and how readers get them back. A run of facts is
// one commit; each progress record is its own line. Readers rebuild each event with where it
// sits and when it was written.

import { isFactType, isProgressType } from "#protocol/session-events/catalog.js";
import type { CommitLine, ProgressLine, StoredLine } from "#protocol/session-events/envelope.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

/** v26 work types that still ride as facts until their family moves. */
const WORK_TYPES: ReadonlySet<string> = new Set([
  "agent.started",
  "approval.candidate",
  "approval.settled",
  "authorization.completed",
  "authorization.required",
  "input.requested",
  "input.resolved",
  "task.settled",
  "task.started",
]);

/** True for a record this version knows: a v27 fact or progress type, or a work type. */
export function isKnownRecordType(type: unknown): boolean {
  return (
    isFactType(type) || isProgressType(type) || (typeof type === "string" && WORK_TYPES.has(type))
  );
}

/**
 * The lines one publication writes: each run of facts as one commit, each progress record as its
 * own line, in order.
 */
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

/**
 * The events a line carries, each with its position and time; a progress record takes
 * `progressAt`, the time of the latest commit. Records of types this version doesn't know are
 * skipped, as every reader skips them.
 */
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

/** Reads events from consecutive lines, keeping the time progress records inherit. */
export function createEventReader(): {
  read(line: StoredLine, position: number): SessionStreamEvent[];
} {
  let lastAt = new Date(0).toISOString();
  return {
    read(line, position) {
      if ("facts" in line) lastAt = line.at;
      return eventsOfLine(line, position, lastAt);
    },
  };
}
