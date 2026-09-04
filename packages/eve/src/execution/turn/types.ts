import type { HookPayload, RunInput, SessionCommand, TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/session/state.js";
import type { SessionResources, SnapshotRecordRef } from "#execution/session/resources.js";
import type { ModelResult } from "#execution/turn/model-types.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";

export interface InitialSessionSeed {
  readonly serializedContext: Record<string, unknown>;
  readonly limits?: RunInput["limits"];
  readonly taskId?: string;
  readonly activityCollectorRunId?: string;
  readonly sessionTimeoutMs?: number | false;
}

export interface AcceptedSubmission {
  readonly eventId: string;
  readonly command:
    | SessionCommand
    | { readonly kind: "session-timeout" }
    | {
        readonly kind: "runtime";
        readonly payload: HookPayload;
      };
  readonly acceptedDeploymentId?: string;
  readonly initial?: InitialSessionSeed;
}

export interface TurnWorkflowInput {
  readonly session: SessionResources;
  readonly submission: AcceptedSubmission;
  readonly afterRunId?: string;
}

export type DeliveryDisposition = "applied" | "retired";

export interface PendingSubmission {
  readonly submission: AcceptedSubmission;
  readonly candidateRunId: string;
}

/** Program state stays in storage; workflows carry only its immutable reference. */
export interface InitializedSessionCheckpoint {
  readonly writeId: string;
  readonly writerRunId: string;
  readonly phase: "running" | "settled" | "terminal";
  /** Alias acknowledged by the holder before this checkpoint was committed. */
  readonly claimedContinuationToken?: string;
  readonly state: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
  readonly deliveries: Readonly<Record<string, DeliveryDisposition>>;
  readonly queue: readonly PendingSubmission[];
  readonly caller?: TurnCaller;
  readonly result?: ModelResult;
  readonly inputs?: readonly PendingSubmission[];
  readonly runtimeResults?: readonly import("#shared/action-types.js").RuntimeActionResult[];
  readonly runtimeResultTimes?: Readonly<Record<string, number>>;
  readonly dispatched?: boolean;
  readonly modelWriteId?: string;
  readonly pendingTaskAcks?: Parameters<
    typeof import("#execution/tasks/dispatch.js").acknowledgeDelegatedTasks
  >[0]["tasks"];
  readonly pendingToolAcks?: readonly import("#execution/workflow-tool/types.js").WorkflowToolRunAddress[];
  readonly timeoutRunId?: string;
  readonly activityCollectorRunId?: string;
}

export interface InitializationFailureCheckpoint {
  readonly writeId: string;
  readonly writerRunId: string;
  readonly phase: "initialization-failed";
  readonly deliveries: Readonly<Record<string, DeliveryDisposition>>;
  readonly queue: readonly [];
  readonly event: import("#protocol/message.js").MessageStreamEvent;
}

export type SessionCheckpoint = InitializedSessionCheckpoint | InitializationFailureCheckpoint;

export interface TurnReceipt {
  readonly continuationToken?: string;
  readonly continuedTo?: string;
  readonly checkpoint?: SnapshotRecordRef;
  readonly deliveries: Readonly<Record<string, DeliveryDisposition>>;
  readonly terminal: boolean;
}

export interface TurnProgress {
  readonly checkpoint: SnapshotRecordRef;
  readonly claimedContinuationToken?: string;
  readonly turnId: string;
  readonly taskId?: string;
  readonly action: "continue" | "dispatch" | "wait" | "settle" | "cancelled";
  readonly terminal: boolean;
  readonly sleepDurationMs?: number;
  readonly sleepKey?: string;
  readonly pendingCallIds?: readonly string[];
  readonly pendingRunIds?: readonly string[];
  readonly continuationToken: string;
}

export type TurnExecutionResult =
  | { readonly kind: "progress"; readonly progress: TurnProgress }
  | { readonly kind: "receipt"; readonly receipt: TurnReceipt }
  | { readonly kind: "wait"; readonly runId: string };

export type TurnWork =
  | { readonly kind: "model"; readonly envelopes?: readonly InboxEnvelope[] }
  | { readonly kind: "dispatch" }
  | { readonly kind: "events"; readonly envelopes: readonly InboxEnvelope[] };

export type TurnSettlementKind =
  | "natural"
  | "cancel"
  | "interrupt"
  | "reset"
  | "timeout"
  | "failure";
