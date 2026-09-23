import type { EveEvalResult, EveEvalTaskResult } from "eve/evals";
import type { AgentReasoningDefinition } from "eve";

export type CapturedEval = Pick<
  EveEvalResult,
  "id" | "verdict" | "assertions" | "error" | "skipReason"
> & {
  result: Pick<EveEvalTaskResult, "sessions" | "derived" | "status">;
};

export type EventReference = { sessionId: string; eventId: string };
export type Measurement =
  | { status: "measured"; value: number; evidence?: readonly EventReference[] }
  | { status: "unavailable" | "not-applicable"; reason: string };

export interface MeasurementBundle {
  version: number;
  metrics: Record<string, { unit: string; direction: "lower" | "higher" | "neutral" }>;
  derive(captured: CapturedEval): Record<string, Measurement>;
}

export type AgentSettings = { model?: string; reasoning?: AgentReasoningDefinition };
export type ScopedSettings = { parent?: AgentSettings; selfModification?: AgentSettings };
export interface Experiment {
  evals: readonly { fixture: string; include: readonly string[] }[];
  settings?: ScopedSettings;
  matrix: {
    /** Omit to use the planner checkout's HEAD, pinned as the source entry "head". */
    source?: Record<string, { revision: string }>;
    configuration: Record<string, ScopedSettings>;
  };
  measurements: Record<string, MeasurementBundle>;
  sampling: { repetitions: number; seed: number };
  execution: { maxConcurrency: number };
  analysis: {
    compare: { axis: "source" | "configuration"; baseline: string };
    primaryMetric: string;
    eligibility: "paired-correct";
  };
}
