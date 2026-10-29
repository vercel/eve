import type { SessionStateMap } from "#harness/types.js";
import type { ValueDelta } from "#shared/value-delta.js";

const HISTORY_BOUNDARIES_KEY = "eve.execution.historyBoundaries";

/** A settled turn's model history ends immediately before `length`. */
export interface HistoryBoundary {
  readonly turnId: string;
  readonly length: number;
  /** The prior conversation turn, not necessarily the preceding turn in the stream. */
  readonly follows: string | null;
}

/** Read the stored boundaries, ignoring malformed records from older or damaged state. */
export function readHistoryBoundaries(state: SessionStateMap | undefined): HistoryBoundary[] {
  const stored = state?.[HISTORY_BOUNDARIES_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((value: unknown): HistoryBoundary[] => {
    if (typeof value !== "object" || value === null) return [];
    const { turnId, length, follows } = value as Record<string, unknown>;
    if (
      typeof turnId !== "string" ||
      turnId.length === 0 ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      (typeof follows !== "string" && follows !== null)
    )
      return [];
    return [{ turnId, length, follows }];
  });
}

/**
 * Where a rewind that keeps `turnId` cuts the model history, and the boundaries it keeps: the
 * target's and those before it. `undefined` when that turn's history is no longer available.
 */
export function findRewindBoundary(
  state: SessionStateMap | undefined,
  historyLength: number,
  turnId: string | undefined,
): { readonly boundary: HistoryBoundary; readonly retained: HistoryBoundary[] } | undefined {
  if (turnId === undefined) return undefined;
  const boundaries = readHistoryBoundaries(state);
  const index = boundaries.findIndex((boundary) => boundary.turnId === turnId);
  const boundary = boundaries[index];
  if (boundary === undefined || boundary.length > historyLength) return undefined;
  return { boundary, retained: boundaries.slice(0, index + 1) };
}

/** Replace the stored boundary index without changing the other session state. */
export function writeHistoryBoundaries(
  state: SessionStateMap | undefined,
  boundaries: readonly HistoryBoundary[],
): SessionStateMap {
  return { ...state, [HISTORY_BOUNDARIES_KEY]: boundaries };
}

/**
 * Keep only boundaries whose entire prefix is unchanged by a history delta.
 *
 * A step may append to history, repair an earlier message, or replace history
 * altogether. A boundary remains usable only when the delta proves that every
 * entry before it is unchanged. In particular, a whole-array replacement is not
 * evidence of an append, even if its last message happens to be the same.
 */
export function retainHistoryBoundaries(
  boundaries: readonly HistoryBoundary[],
  previousLength: number,
  delta: ValueDelta | undefined,
): HistoryBoundary[] {
  if (delta === undefined)
    return boundaries.filter(({ length }) => validLength(length, previousLength));
  if (delta.kind !== "array") return [];

  const changed = [...Object.keys(delta.set ?? {}), ...Object.keys(delta.patch ?? {})];
  return boundaries.filter(({ length }) => {
    if (!validLength(length, previousLength) || length > delta.length) return false;
    return changed.every((key) => {
      const index = Number(key);
      return Number.isSafeInteger(index) && index >= length && String(index) === key;
    });
  });
}

function validLength(length: number, previousLength: number): boolean {
  return Number.isSafeInteger(length) && length >= 0 && length <= previousLength;
}
