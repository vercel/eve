import type { RuntimeIdentity } from "#protocol/message.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

// The change points today's participants name with their event keys. They are never published:
// v27 facts mark the points, and participants map each fact to the key their authors wrote. A
// dynamic resolver's handler receives the point's `fact`; `data` is what eve itself keys on.

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
  /** What a `session.started` handler receives: the session's start. */
  readonly fact: FactOf<"session.started">;
}

/** A turn starts. */
export interface TurnStartedPoint {
  readonly type: "turn.started";
  readonly data: { readonly sequence: number; readonly turnId: string };
  /** What a `turn.started` handler receives: the turn's start. */
  readonly fact: FactOf<"turn.started">;
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
  /** What a `step.started` handler receives: the turn's request for the model run. */
  readonly fact: FactOf<"model.requested">;
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

export function sessionStartedForResolvers(fact: FactOf<"session.started">): SessionStartedPoint {
  const { runtime } = fact.data;
  return { data: runtime === undefined ? {} : { runtime }, fact, type: "session.started" };
}

export function turnStartedForResolvers(
  turn: { readonly sequence: number; readonly turnId: string },
  fact: FactOf<"turn.started">,
): TurnStartedPoint {
  return { data: { sequence: turn.sequence, turnId: turn.turnId }, fact, type: "turn.started" };
}

export function stepStartedForResolvers(
  step: {
    readonly modelId: string;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  },
  fact: FactOf<"model.requested">,
): StepStartedPoint {
  const { modelId, sequence, stepIndex, turnId } = step;
  return { data: { modelId, sequence, stepIndex, turnId }, fact, type: "step.started" };
}

/**
 * The session's start, as a restored step knows it: its runtime. The parent and trace the start
 * recorded aren't kept past it.
 */
export function sessionStartedFact(runtime?: RuntimeIdentity): FactOf<"session.started"> {
  return { data: runtime === undefined ? {} : { runtime }, type: "session.started" };
}

/** A turn's start, rebuilt from the turn's row when a restored step needs it again. */
export function turnStartedFact(view: SessionView, turnId: string): FactOf<"turn.started"> {
  const row = view.turns[turnId];
  return {
    data: { cause: row?.cause ?? { turnId }, follows: row?.follows ?? null, turnId },
    scope: { turnId },
    type: "turn.started",
  };
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

/** A turn's request for a model run, rebuilt when a restored step needs it again. */
export function modelRequestedFact(turnId: string, runId: string): FactOf<"model.requested"> {
  return { data: { owner: { turnId }, runId }, scope: { runId, turnId }, type: "model.requested" };
}
