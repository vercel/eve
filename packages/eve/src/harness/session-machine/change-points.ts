import type { RuntimeIdentity } from "#protocol/message.js";

// The change points today's participants name with v26 event keys, and the minimal payload their
// handlers receive. They are never published: v27 facts mark the points, and participants map
// each fact to the key their authors wrote. These types stand alone, so they outlive the v26
// event builders until participants name no events at all.

export type ChangePointEvent =
  | SessionStartedPoint
  | TurnStartedPoint
  | StepStartedPoint
  | TurnCompletedPoint
  | CompactionRequestedPoint
  | CompactionCompletedPoint;

/** The session's first turn starts. */
export interface SessionStartedPoint {
  readonly type: "session.started";
  readonly data: { readonly runtime?: RuntimeIdentity };
}

/** A turn starts. */
export interface TurnStartedPoint {
  readonly type: "turn.started";
  readonly data: { readonly sequence: number; readonly turnId: string };
}

/** A turn requests a model run, before its model and tools are chosen. */
export interface StepStartedPoint {
  readonly type: "step.started";
  readonly data: {
    readonly modelId: string;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
}

/** A turn completed. */
export interface TurnCompletedPoint {
  readonly type: "turn.completed";
  readonly data: { readonly sequence: number; readonly turnId: string };
}

/** A compaction starts, before its summary run. `turnId` is `""` between turns. */
export interface CompactionRequestedPoint {
  readonly type: "compaction.requested";
  readonly data: {
    readonly modelId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly stepIndex: number;
    readonly turnId: string;
    readonly usageInputTokens: number | null;
  };
}

/** A compaction completed. `turnId` is `""` between turns. */
export interface CompactionCompletedPoint {
  readonly type: "compaction.completed";
  readonly data: {
    readonly modelId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly stepIndex: number;
    readonly turnId: string;
  };
}

export function sessionStartedForResolvers(runtime?: RuntimeIdentity): SessionStartedPoint {
  return { data: runtime === undefined ? {} : { runtime }, type: "session.started" };
}

export function turnStartedForResolvers(turn: {
  readonly sequence: number;
  readonly turnId: string;
}): TurnStartedPoint {
  return { data: { sequence: turn.sequence, turnId: turn.turnId }, type: "turn.started" };
}

export function stepStartedForResolvers(step: {
  readonly modelId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): StepStartedPoint {
  const { modelId, sequence, stepIndex, turnId } = step;
  return { data: { modelId, sequence, stepIndex, turnId }, type: "step.started" };
}

export function turnCompletedPoint(turn: {
  readonly sequence: number;
  readonly turnId: string;
}): TurnCompletedPoint {
  return { data: { sequence: turn.sequence, turnId: turn.turnId }, type: "turn.completed" };
}

export function compactionRequestedPoint(
  data: CompactionRequestedPoint["data"],
): CompactionRequestedPoint {
  return { data, type: "compaction.requested" };
}

export function compactionCompletedPoint(
  data: CompactionCompletedPoint["data"],
): CompactionCompletedPoint {
  return { data, type: "compaction.completed" };
}
