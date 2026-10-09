// v26 event types ride inside v27 lines until their family moves (PR 6 and 7). Producers still
// build v26 events; the writer places them in lines, and readers that still read v26 events get
// them back from each line with the `meta` they carried. This module goes away with the last v26
// reader.

import type { CommitLine, ProgressLine, StoredLine } from "#protocol/session-events/envelope.js";
import type { MessageStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";

/** v26 types that stream a preview, and so ride as progress records. */
const LEGACY_PROGRESS_TYPES: ReadonlySet<string> = new Set([
  "action.input.appended",
  "action.partial",
  "message.appended",
  "reasoning.appended",
]);

/** A v26 event as a stored fact or progress record: its type and data, and its delivery ids. */
export type LegacyRecord = UnstampedMessageStreamEvent & {
  readonly meta?: { readonly deliveryIds: readonly string[] };
};

export type LegacyLine = StoredLine<LegacyRecord, LegacyRecord>;

/** True for a v26 event that rides as progress rather than in a commit. */
export function isLegacyProgress(event: { readonly type: string }): boolean {
  return LEGACY_PROGRESS_TYPES.has(event.type);
}

/**
 * The lines one publication writes: each run of facts as one commit, each progress record as its
 * own line, in order.
 */
export function linesOf(
  events: readonly UnstampedMessageStreamEvent[],
  at: string,
  deliveryIds: readonly string[] | undefined,
): LegacyLine[] {
  const lines: LegacyLine[] = [];
  let facts: LegacyRecord[] = [];
  const flush = () => {
    if (facts.length === 0) return;
    lines.push({ at, facts } satisfies CommitLine<LegacyRecord>);
    facts = [];
  };
  for (const event of events) {
    const record: LegacyRecord =
      deliveryIds !== undefined && deliveryIds.length > 0
        ? { ...event, meta: { deliveryIds } }
        : event;
    if (isLegacyProgress(event)) {
      flush();
      lines.push({ progress: record } satisfies ProgressLine<LegacyRecord>);
    } else {
      facts.push(record);
    }
  }
  flush();
  return lines;
}

/** The id a v26 reader sees for the record at `index` in the line at `position`. Stable across reads. */
export function eventIdAt(position: number, index: number): string {
  return `evt_${String(position)}_${String(index)}`;
}

/**
 * The v26 events a line carries, with the `meta` v26 readers expect: the line's time (a progress
 * record takes `progressAt`, the time of the latest commit), an id from its position, and its
 * delivery ids. Records of v27 types are skipped: v26 readers don't know them.
 */
export function eventsOfLine(
  line: StoredLine,
  position: number,
  progressAt: string,
): MessageStreamEvent[] {
  const records: readonly unknown[] = "facts" in line ? line.facts : [line.progress];
  const at = "facts" in line ? line.at : progressAt;
  const events: MessageStreamEvent[] = [];
  records.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object") return;
    const record = raw as LegacyRecord;
    if (typeof record.type !== "string" || !isLegacyType(record.type)) return;
    const { meta, ...event } = record;
    const stamped: { at: string; id: string; deliveryIds?: readonly string[] } = {
      at,
      id: eventIdAt(position, index),
    };
    if (meta?.deliveryIds !== undefined) stamped.deliveryIds = meta.deliveryIds;
    events.push({ ...event, meta: stamped } as MessageStreamEvent);
  });
  return events;
}

/** Reads v26 events from consecutive lines, keeping the time progress records inherit. */
export function createLegacyEventReader(): {
  read(line: StoredLine, position: number): MessageStreamEvent[];
} {
  let lastAt = new Date(0).toISOString();
  return {
    read(line, position) {
      if ("facts" in line) lastAt = line.at;
      return eventsOfLine(line, position, lastAt);
    },
  };
}

const V26_TYPES: ReadonlySet<string> = new Set([
  "action.input.appended",
  "action.partial",
  "action.result",
  "actions.requested",
  "agent.started",
  "approval.candidate",
  "approval.settled",
  "authorization.completed",
  "authorization.required",
  "compaction.completed",
  "compaction.requested",
  "context.cleared",
  "input.requested",
  "input.resolved",
  "message.appended",
  "message.completed",
  "message.received",
  "reasoning.appended",
  "reasoning.completed",
  "result.completed",
  "session.completed",
  "session.failed",
  "session.started",
  "session.waiting",
  "step.completed",
  "step.failed",
  "step.started",
  "task.settled",
  "task.started",
  "turn.cancelled",
  "turn.completed",
  "turn.failed",
  "turn.started",
  "turn.waiting",
]);

function isLegacyType(type: string): boolean {
  return V26_TYPES.has(type);
}
