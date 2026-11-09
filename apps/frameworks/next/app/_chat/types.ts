import type { SessionStreamEvent } from "eve/client";

export type TranscriptStreamEvent = SessionStreamEvent;

/**
 * Derived status for one trace step in the local trace viewer.
 *
 * `aborted` means the model run was interrupted or abandoned, or its turn ended before the run
 * settled.
 */
export type TraceStepStatus = "aborted" | "completed" | "failed" | "running";

/**
 * Token usage projected onto one completed trace step.
 */
export interface TraceStepUsage {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Derived runtime action reconstructed from the persisted session stream.
 */
export type TraceActionKind = "load-skill" | "subagent-call" | "tool-call" | "unknown";

/**
 * Derived status for one runtime action in the local trace viewer.
 *
 * `running` means the call started and hasn't settled. `requested` means the model made the call
 * and it hasn't started, as while it waits for approval. `aborted` means the call was
 * interrupted or abandoned, or its turn ended before it settled.
 */
export type TraceActionStatus = "aborted" | "completed" | "failed" | "requested" | "running";

/**
 * Stable error payload projected onto one failed runtime action.
 */
export interface TraceActionError {
  readonly code: string;
  readonly message: string;
}

/**
 * One runtime action request/result pair reconstructed from transcript events.
 */
export interface TraceAction {
  readonly callId: string;
  readonly durationMs?: number;
  readonly endTime?: string;
  readonly error?: TraceActionError;
  readonly input?: unknown;
  readonly kind: TraceActionKind;
  readonly name: string;
  readonly output?: unknown;
  readonly startTime?: string;
  readonly status: TraceActionStatus;
}

/**
 * Derived model step reconstructed from the persisted session stream.
 */
export interface TraceStep {
  readonly actions: readonly TraceAction[];
  readonly actionCount: number;
  readonly durationMs?: number;
  readonly endTime?: string;
  readonly errorMessage?: string;
  readonly events: readonly TranscriptStreamEvent[];
  readonly finishReason?: string;
  readonly reasoningText?: string;
  readonly responseText?: string;
  readonly startTime?: string;
  readonly status: TraceStepStatus;
  readonly stepIndex: number;
  readonly subagentCount: number;
  readonly usage?: TraceStepUsage;
}

/**
 * Derived status for one rendered row in the local trace timeline.
 */
export type TraceTimelineRowStatus = "aborted" | "active" | "failed" | "normal";

/**
 * Derived turn state reconstructed from the persisted session stream.
 */
export type TraceTurnStatus = "completed" | "failed" | "running";

export interface TraceTurn {
  readonly assistantMessage?: string;
  readonly durationMs?: number;
  readonly endTime?: string;
  readonly events: readonly TranscriptStreamEvent[];
  /** Why the turn or its session failed. */
  readonly failureMessage?: string;
  readonly sequence?: number;
  readonly startTime?: string;
  readonly steps: readonly TraceStep[];
  readonly status: TraceTurnStatus;
  readonly subagentCount: number;
  readonly turnId: string;
  readonly userMessage?: string;
}
