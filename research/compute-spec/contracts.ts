/**
 * Reference contracts for the two implementation plans.
 *
 * A1-owned cell, effect, value, receipt, and error contracts are re-exported
 * from their production owner. Resumable-task and later-milestone contracts
 * remain reference-only until their implementation milestones.
 */
export { ComputeError, defineCell, defineEffect } from "../../packages/eve/src/compute/index.js";
export type * from "../../packages/eve/src/compute/protocol.js";

import type {
  CellMessage,
  ChildStart,
  Counter,
  DefinitionId,
  DeliveryContext,
  Digest,
  DurableEvent,
  EffectRequest,
  Id,
  Json,
  PayloadRef,
  Result,
  RetryPolicy,
  ValueSchema,
  VersionedValue,
  WireValue,
} from "../../packages/eve/src/compute/protocol.js";

export interface StartRequest {
  definition: DefinitionId;
  input: VersionedValue;
  idempotencyKey: string;
}

export interface StartReceipt {
  resumableTaskId: Id;
  status: TaskStatus;
}

export type TaskStatus =
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface TaskView {
  resumableTaskId: Id;
  status: TaskStatus;
  revision: Counter;
  checkpointVersion: number;
  cancellationGeneration: Counter;
  result: Result<WireValue> | null;
}

export type WaitCondition =
  | { id: string; kind: "signal"; signalKey: string }
  | { id: string; kind: "timer"; deadline: string }
  | { id: string; kind: "child"; resumableTaskId: Id };

export type ResumableTaskWait = WaitCondition | { kind: "all"; conditions: WaitCondition[] };

export type WaitResult<T> = Result<T>;

export interface SignalRequest {
  signalId: string;
  signalKey: string;
  cancellationGeneration: Counter;
  value: VersionedValue;
}

export interface SignalReceipt {
  signalId: string;
  status: "buffered" | "matched";
}

export interface MutationOptions {
  acknowledgeWaits?: string[];
}

export interface BatchOutcome {
  key: string;
  result: Result<unknown>;
  resultRef: PayloadRef | null;
}

export interface ResumableTaskContext<C> {
  readonly resumableTaskId: Id;
  readonly signal: AbortSignal;
  checkpoint(value: C, options?: MutationOptions): Promise<void>;
  effect<T>(
    request: EffectRequest & { checkpoint: C } & MutationOptions,
  ): Promise<{ value: T; resultRef: PayloadRef }>;
  effectBatch(
    request: { key: string; checkpoint: C; effects: EffectRequest[] } & MutationOptions,
  ): Promise<BatchOutcome[]>;
  child(
    request: ChildStart & { checkpoint: C } & MutationOptions,
  ): Promise<{ resumableTaskId: Id }>;
  park(
    request: { key: string; checkpoint: C; wait: ResumableTaskWait } & MutationOptions,
  ): Promise<never>;
  waitResult<T>(key: string): Promise<WaitResult<T> | undefined>;
  emit(event: { key: string; value: unknown }): Promise<void>;
}

export interface ResumableTaskDefinition<I, C, O> {
  inputVersion: number;
  checkpointVersion: number;
  inputSchema: ValueSchema<I>;
  checkpointSchema: ValueSchema<C>;
  outputSchema: ValueSchema<O>;
  start(input: I, context: ResumableTaskContext<C>): Promise<O>;
  resume(input: I, checkpoint: C, context: ResumableTaskContext<C>): Promise<O>;
  migrateInput(fromVersion: number, value: unknown): I;
  migrateCheckpoint(fromVersion: number, value: unknown): C;
}

export declare function defineResumableTask<I, C, O>(
  definition: ResumableTaskDefinition<I, C, O>,
): ResumableTaskDefinition<I, C, O>;

export interface LeaseToken {
  resourceId: Id;
  assignmentId: Id;
  ownerId: Id;
  epoch: Counter;
  cancellationGeneration: Counter;
  deployment: Digest;
}

export interface RunnerAssignment {
  namespaceId: Id;
  token: LeaseToken;
  kind: "cell" | "effect" | "resumable_task";
  mode: "execute" | "migrate";
  definition: DefinitionId;
  input: VersionedValue;
  checkpoint: VersionedValue | null;
  checkpointRevision: Counter;
  delivery: DeliveryContext | null;
}

export interface CheckpointUpdate {
  checkpoint: VersionedValue;
  acknowledgeWaits: string[];
}

export type DurableCommand =
  | { method: "commit_transition"; messageId: Id; transition: WireValue }
  | {
      method: "adopt_migration";
      input: VersionedValue | null;
      state: VersionedValue | null;
    }
  | { method: "checkpoint"; update: CheckpointUpdate }
  | { method: "register_effects"; update: CheckpointUpdate; effects: WireValue }
  | { method: "start_child"; update: CheckpointUpdate; child: WireValue }
  | { method: "park"; update: CheckpointUpdate; key: string; wait: ResumableTaskWait }
  | { method: "emit"; key: string; value: WireValue }
  | { method: "complete"; result: Result<WireValue> };

export type RunnerToSupervisor =
  | { type: "ready"; deployment: Digest; protocol: 1 }
  | { type: "alive"; assignmentId: Id }
  | {
      type: "command";
      token: LeaseToken;
      requestId: Id;
      commandSequence: Counter;
      expectedRevision: Counter;
      command: DurableCommand;
    }
  | { type: "read_wait"; token: LeaseToken; requestId: Id; key: string }
  | { type: "read_effect"; token: LeaseToken; requestId: Id; effectId: Id };

export type SupervisorToRunner =
  | { type: "assign"; assignment: RunnerAssignment }
  | { type: "stop"; assignmentId: Id; reason: "cancelled" | "drain" | "lease_lost" }
  | {
      type: "reply";
      requestId: Id;
      result: Result<{
        revision: Counter;
        value: WireValue | null;
        control: "continue" | "release";
      }>;
    }
  | { type: "dependency_changed"; assignmentId: Id; dependencyId: Id };

export interface DeploymentManifest {
  protocol: 1;
  image: Digest;
  artifactManifestHash: Digest;
  definitions: Array<{
    id: DefinitionId;
    kind: "cell" | "effect" | "resumable_task";
    module: string;
    export: string;
    inputVersion: number;
    stateVersion: number | null;
    outputVersion: number | null;
    retry: RetryPolicy | null;
  }>;
}

export interface ActivateRequest {
  deployment: Digest;
  expectedEpoch: Counter;
}

export interface RevisionCommand {
  expectedRevision: Counter;
  idempotencyKey: string;
}

export interface EffectReconciliation extends RevisionCommand {
  outcome:
    | { action: "record_result"; result: Result<WireValue>; evidence: string }
    | { action: "authorize_retry"; evidence: string };
}

export interface TurnCursor {
  sessionId: string;
  turnId: string;
  generation: Counter;
  phase: "prepare" | "compact" | "model" | "tools" | "wait" | "finalize" | "settled";
  step: number;
  sessionRef: PayloadRef;
  inputRef: PayloadRef | null;
  contextRef: PayloadRef;
  historyRef: PayloadRef;
  pending: Array<{
    key: string;
    effectId: Id | null;
    callId: string | null;
    result: Result<PayloadRef> | null;
  }>;
}

export interface TurnSnapshotRefs {
  sessionRef: PayloadRef;
  contextRef: PayloadRef;
  historyRef: PayloadRef;
}

export interface PendingTurnWait {
  key: string;
  spec: ResumableTaskWait;
}

export interface PreparedToolCall {
  callId: string;
  toolName: string;
  inputRef: PayloadRef;
}

export type TurnEffectValue =
  | {
      kind: "prepared";
      snapshot: TurnSnapshotRefs;
      next: "model" | "compact" | "tools" | "wait" | "finalize";
      preparedInputRef: PayloadRef;
      calls: PreparedToolCall[];
      wait: PendingTurnWait | null;
    }
  | {
      kind: "model";
      snapshot: TurnSnapshotRefs;
      next: "prepare" | "tools" | "wait" | "finalize";
      calls: PreparedToolCall[];
      wait: PendingTurnWait | null;
    }
  | { kind: "tool"; callId: string; outputRef: PayloadRef; contextDeltaRef: PayloadRef }
  | { kind: "compacted"; snapshot: TurnSnapshotRefs; preparedInputRef: PayloadRef }
  | { kind: "finalized"; snapshot: TurnSnapshotRefs; resultRef: PayloadRef };

export type TurnEvent =
  | { kind: "input"; inputRef: PayloadRef }
  | { kind: "effect"; key: string; result: Result<TurnEffectValue> }
  | { kind: "answer"; requestId: string; answerRef: PayloadRef }
  | { kind: "cancel"; generation: Counter };

export interface TurnDecision {
  cursor: TurnCursor;
  effects: EffectRequest[];
  sends: CellMessage[];
  events: DurableEvent[];
  wait: PendingTurnWait | null;
  terminal: boolean;
}

export interface TurnDriver {
  reduce(cursor: Readonly<TurnCursor>, event: TurnEvent): TurnDecision;
}

export interface ProgramInput {
  source: string;
  input: Json;
}

export type ProgramStep =
  | {
      kind: "dispatch";
      state: Json;
      calls: Array<{ key: string; agent: string; input: Json }>;
    }
  | { kind: "complete"; output: Json }
  | { kind: "fail"; message: string };

export interface MigrationBundle {
  format: "eve-compute-export-v1";
  namespaceId: Id;
  batchId: Id;
  source: {
    artifact: Digest;
    adapter: "cursor-v1";
    freezeProofs: Array<{ runId: string; frontier: Counter; digest: Digest }>;
  };
  sessions: Array<{
    publicSessionId: string;
    snapshot: VersionedValue;
    context: VersionedValue;
    aliases: string[];
    eventTail: Counter;
    historyRef: PayloadRef;
    pendingWorkRefs: PayloadRef[];
  }>;
  payloads: Array<{ id: PayloadRef; hash: Digest; value: WireValue }>;
  manifestHash: Digest;
}
