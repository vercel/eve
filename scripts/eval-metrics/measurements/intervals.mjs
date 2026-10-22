import { selectEvents, timestamp, unavailable } from "./events.mjs";

/**
 * @typedef {{ key: string, start: object, end: object, startAt: number, endAt: number }} Interval
 * @typedef {{ status: "ready", intervals: Interval[] } | { status: "unavailable", reason: string }} Intervals
 */

/**
 * Pair start and end events by key, independent of capture order. One event
 * may open or close several keys (an `actions.requested` batch, an
 * `input.resolved` batch). Every start needs exactly one end and vice versa;
 * `repeatedStarts: "earliest"` tolerates re-announced starts such as repeated
 * approval candidates for one request.
 *
 * @param {object[]} starts
 * @param {object[]} ends
 * @param {{
 *   startKeys: (event: object) => unknown[],
 *   endKeys: (event: object) => unknown[],
 *   subject: string,
 *   repeatedStarts?: "ambiguous" | "earliest",
 *   closeOpen?: (start: object) => object | undefined,
 * }} options `closeOpen` may supply an end for a start that has none, such as
 *   the terminal event of a cancelled turn.
 * @returns {Intervals}
 */
export function pairIntervals(
  starts,
  ends,
  { startKeys, endKeys, subject, repeatedStarts, closeOpen },
) {
  const opened = indexByKey(starts, startKeys, repeatedStarts === "earliest");
  if (opened === undefined) return unavailable(`missing-${subject}-identity`);
  if (opened === "ambiguous") return unavailable(`ambiguous-${subject}`);
  const closed = indexByKey(ends, endKeys, false);
  if (closed === undefined) return unavailable(`missing-${subject}-identity`);
  if (closed === "ambiguous") return unavailable(`ambiguous-${subject}`);

  const intervals = [];
  for (const [key, start] of opened) {
    const end = closed.get(key) ?? closeOpen?.(start);
    if (end === undefined) return unavailable(`${subject}-incomplete`);
    const startAt = timestamp(start);
    const endAt = timestamp(end);
    if (startAt === undefined || endAt === undefined) return unavailable("missing-timestamp");
    if (endAt < startAt) return unavailable("negative-duration");
    intervals.push({ key, start, end, startAt, endAt });
  }
  if ([...closed.keys()].some((key) => !opened.has(key)))
    return unavailable(`${subject}-start-missing`);
  return { status: "ready", intervals };
}

function indexByKey(events, keysOf, keepEarliest) {
  const byKey = new Map();
  for (const event of events) {
    const keys = keysOf(event);
    if (!Array.isArray(keys) || keys.length === 0) return undefined;
    for (const key of keys) {
      if (typeof key !== "string" || key.length === 0) return undefined;
      const earlier = byKey.get(key);
      if (earlier === undefined) byKey.set(key, event);
      else if (!keepEarliest) return "ambiguous";
      else if ((timestamp(event) ?? Infinity) < (timestamp(earlier) ?? Infinity))
        byKey.set(key, event);
    }
  }
  return byKey;
}

/**
 * Merge overlapping or touching intervals into a sorted disjoint list.
 *
 * @param {readonly { startAt: number, endAt: number }[]} intervals
 * @returns {{ startAt: number, endAt: number }[]}
 */
export function unionIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startAt - b.startAt);
  const merged = [];
  for (const { startAt, endAt } of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && startAt <= last.endAt) last.endAt = Math.max(last.endAt, endAt);
    else merged.push({ startAt, endAt });
  }
  return merged;
}

/** Total covered length of possibly overlapping intervals. */
export function coveredLength(intervals) {
  return unionIntervals(intervals).reduce(
    (total, { startAt, endAt }) => total + endAt - startAt,
    0,
  );
}

/**
 * Covered length of `intervals` that lies inside `within` and outside `excluding`.
 *
 * @param {readonly { startAt: number, endAt: number }[]} intervals
 * @param {{ within?: readonly { startAt: number, endAt: number }[], excluding?: readonly { startAt: number, endAt: number }[] }} [bounds]
 */
export function coveredLengthBetween(intervals, { within, excluding = [] } = {}) {
  let covered = unionIntervals(intervals);
  if (within !== undefined) covered = intersect(covered, unionIntervals(within));
  const removed = intersect(covered, unionIntervals(excluding));
  return lengthOf(covered) - lengthOf(removed);
}

function intersect(left, right) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const startAt = Math.max(left[i].startAt, right[j].startAt);
    const endAt = Math.min(left[i].endAt, right[j].endAt);
    if (startAt < endAt) result.push({ startAt, endAt });
    if (left[i].endAt < right[j].endAt) i += 1;
    else j += 1;
  }
  return result;
}

function lengthOf(disjoint) {
  return disjoint.reduce((total, { startAt, endAt }) => total + endAt - startAt, 0);
}

/**
 * For each started model step, find the first streamed text or reasoning
 * delta of that step. Steps that stream no delta (e.g. tool-call only) map to
 * `undefined`; callers decide whether that is not-applicable.
 *
 * @param {object[]} events one session's events
 * @returns {Map<string, { start: object, firstDelta: object | undefined }>} keyed by `turnId/stepIndex`
 */
export function firstDeltaInStep(events) {
  const steps = new Map();
  for (const start of selectEvents(events, "step.started")) {
    const key = stepKey(start);
    if (key !== undefined) steps.set(key, { start, firstDelta: undefined });
  }
  for (const event of events) {
    if (event.type !== "message.appended" && event.type !== "reasoning.appended") continue;
    const step = steps.get(stepKey(event));
    if (step === undefined) continue;
    const at = timestamp(event);
    if (at === undefined) continue;
    if (step.firstDelta === undefined || at < timestamp(step.firstDelta)) step.firstDelta = event;
  }
  return steps;
}

/** Identity of one model step within a session. */
export function stepKey(event) {
  const { turnId, stepIndex } = event.data ?? {};
  return typeof turnId === "string" && Number.isInteger(stepIndex)
    ? `${turnId}/${stepIndex}`
    : undefined;
}
