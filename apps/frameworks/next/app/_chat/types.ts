import type { AgentInformation } from "./workflow-api";

export type ComposeState =
  | {
      readonly status: "idle";
    }
  | {
      readonly status: "sending";
    }
  | {
      readonly status: "streaming";
    }
  | {
      readonly message: string;
      readonly status: "error";
    };

export type AgentInfoState =
  | {
      readonly status: "idle";
    }
  | {
      readonly status: "loading";
    }
  | {
      readonly message: string;
      readonly status: "error";
    }
  | {
      readonly info: AgentInformation;
      readonly status: "ready";
      readonly updatedAt: number;
    };

export interface ChatSessionCursor {
  readonly continuationToken?: string;
  readonly sessionId?: string;
  readonly streamIndex: number;
}

export interface TranscriptMessageReceivedEvent {
  readonly data: {
    readonly message: string;
  };
  readonly type: "message.received";
}

export interface TranscriptMessageCompletedEvent {
  readonly data: {
    readonly finishReason?: string;
    readonly message: string | null;
  };
  readonly type: "message.completed";
}

export interface TranscriptSessionFailedEvent {
  readonly data: {
    readonly message: string;
  };
  readonly type: "session.failed";
}

export interface TranscriptEventMeta {
  readonly at: string;
}

export type TranscriptStreamEvent = (
  | TranscriptMessageCompletedEvent
  | TranscriptMessageReceivedEvent
  | TranscriptSessionFailedEvent
  | {
      readonly data?: unknown;
      readonly type: string;
    }
) & {
  readonly meta?: TranscriptEventMeta;
};

/**
 * Derived status for one trace step in the local trace viewer.
 *
 * `aborted` means the turn or session failed before the step emitted a
 * terminal `step.completed` or `step.failed` event.
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
 * `running` means the runtime started the action batch and no matching
 * `action.result` has arrived yet. `requested` is reserved for approval-gated
 * actions that are waiting on human input. `aborted` means the surrounding turn
 * or session failed before the action produced a terminal result.
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
  readonly sequence?: number;
  readonly startTime?: string;
  readonly steps: readonly TraceStep[];
  readonly status: TraceTurnStatus;
  readonly subagentCount: number;
  readonly turnId: string;
  readonly userMessage?: string;
}

/**
 * One restored thread in the local web UI, expressed directly in reconstructed
 * transcript turns so chat and debugger can render from the same source.
 */
export interface ThreadState {
  readonly continuationToken?: string;
  readonly sessionId: string;
  readonly streamIndex: number;
  readonly turns: readonly TraceTurn[];
}
