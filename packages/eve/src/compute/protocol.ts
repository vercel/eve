export type Id = string;
export type Counter = `${bigint}`;
export type Digest = `sha256:${string}`;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type DefinitionId = string;
export type PayloadRef = Id;

/** Opaque value encoded by the versioned eve compute codec. */
export interface WireValue {
  codec: "eve-value-v1";
  data: string;
}

export interface VersionedValue {
  version: number;
  value: WireValue;
}

/** Validator boundary used by compute definitions for authored values. */
export interface ValueSchema<T> {
  parse(value: unknown): T;
}

export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "STALE_EXECUTION"
  | "CONCURRENT_MUTATION"
  | "PAYLOAD_TOO_LARGE"
  | "QUOTA_EXCEEDED"
  | "TRANSIENT_FAILURE"
  | "EFFECT_FAILED"
  | "INDETERMINATE_EFFECT"
  | "MIGRATION_REQUIRED"
  | "UNSUPPORTED_EXPORT"
  | "DEPLOYMENT_UNAVAILABLE"
  | "CANCELLED"
  | "INTERNAL";

/** Sanitized failure that may cross a compute process or HTTP boundary. */
export interface Failure {
  code: ErrorCode;
  message: string;
  incidentId?: Id;
}

export type Result<T> =
  | { status: "succeeded"; value: T }
  | { status: "failed"; error: Failure }
  | { status: "cancelled" };

/** Durable address of one keyed cell. */
export interface CellAddress {
  namespaceId: Id;
  definition: DefinitionId;
  key: string;
}

/** Protected admission metadata supplied by the platform to a cell transition. */
export interface DeliveryContext {
  cellId: Id;
  deliveryId: string;
  sequence: Counter;
  acceptedAt: string;
  origin:
    | { kind: "external"; principalId: string }
    | { kind: "cell"; sourceCellId: Id }
    | { kind: "effect"; effectId: Id; generation: Counter }
    | { kind: "timer"; timerKey: string; generation: Counter }
    | { kind: "child"; resumableTaskId: Id; generation: Counter };
}

/** Retry behavior fixed by a registered effect definition. */
export type RetryPolicy =
  | { mode: "manual"; timeoutMs: number }
  | { mode: "idempotent"; maxAttempts: number; timeoutMs: number };

/** Durable asynchronous operation requested by a cell transition. */
export interface EffectRequest {
  key: string;
  definition: DefinitionId;
  inputVersion: number;
  input: unknown;
}

/** Execution context supplied to one independently leased effect attempt. */
export interface EffectContext {
  effectId: Id;
  attemptId: Id;
  idempotencyKey: string;
  signal: AbortSignal;
  emit(event: { key: string; value: unknown }): Promise<void>;
}

/** Registered asynchronous effect with versioned input and output. */
export interface EffectDefinition<I, O> {
  inputVersion: number;
  outputVersion: number;
  inputSchema: ValueSchema<I>;
  outputSchema: ValueSchema<O>;
  retry: RetryPolicy;
  execute(input: I, context: EffectContext): Promise<O>;
  migrateOutput(fromVersion: number, value: unknown): O;
}

export interface CellMessage {
  key: string;
  destination: CellAddress;
  messageVersion: number;
  message: unknown;
}

export type TimerRequest =
  | { action: "cancel"; key: string }
  | {
      action: "set";
      key: string;
      deadline: string;
      messageVersion: number;
      message: unknown;
    };

export interface DurableEvent {
  key: string;
  value: unknown;
}

export interface ChildStart {
  key: string;
  definition: DefinitionId;
  inputVersion: number;
  input: unknown;
  detached?: boolean;
}

export type SystemMessage =
  | { kind: "effect_result"; key: string; effectId: Id; result: Result<unknown> }
  | { kind: "child_result"; key: string; resumableTaskId: Id; result: Result<unknown> };

/** Atomic state and durable work proposed by one cell message. */
export interface Transition<S> {
  state: S;
  effects?: EffectRequest[];
  sends?: CellMessage[];
  timers?: TimerRequest[];
  children?: ChildStart[];
  events?: DurableEvent[];
  terminal?: boolean;
}

/** Synchronous state-machine definition for one path-derived cell family. */
export interface CellDefinition<S, M> {
  stateVersion: number;
  messageVersion: number;
  stateSchema: ValueSchema<S>;
  messageSchema: ValueSchema<M>;
  initial(): S;
  receive(
    state: Readonly<S>,
    message: Readonly<M> | SystemMessage,
    context: DeliveryContext,
  ): Transition<S>;
  migrateState(fromVersion: number, value: unknown): S;
  migrateMessage(fromVersion: number, value: unknown): M;
}

export interface SendRequest {
  address: Omit<CellAddress, "namespaceId">;
  message: VersionedValue;
  idempotencyKey: string;
}

/** Idempotency options for durable message admission. */
export interface SendOptions {
  idempotencyKey: string;
}

/** Authored value paired with its definition schema version. */
export interface VersionedInput<T = unknown> {
  version: number;
  value: T;
}

/** Durable receipt returned after message admission commits. */
export interface MessageReceipt {
  cellId: Id;
  messageId: Id;
  sequence: Counter;
  status: "pending" | "applied" | "rejected" | "cancelled";
}

/** Inspectable persisted state for one cell. */
export interface CellView {
  cellId: Id;
  status: "active" | "quarantined" | "terminal";
  revision: Counter;
  deployment: Digest;
  state: VersionedValue | null;
}

/** One persisted event in cell-local sequence order. */
export interface EventRecord {
  id: Id;
  sequence: Counter;
  value: WireValue;
  source: { operationId: Id; attemptId: Id | null };
}

/** Inspectable namespace deployment and quota state. */
export interface NamespaceView {
  namespaceId: Id;
  deploymentEpoch: Counter;
  admissionMode: "open" | "staging" | "frozen";
  desiredDeployment: Digest | null;
  usedBytes: Counter;
  quotaBytes: Counter;
}

/** Finite event-read options; following streams arrive in milestone A5. */
export interface ReadEventsOptions {
  after?: Counter;
  follow?: boolean;
  limit?: number;
}

/** Internal fenced ownership identity used by compute executors. */
export interface LeaseToken {
  resourceId: Id;
  assignmentId: Id;
  ownerId: Id;
  epoch: Counter;
  cancellationGeneration: Counter;
  deployment: Digest;
}

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
