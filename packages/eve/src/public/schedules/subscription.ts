import type { SessionSendOptions } from "#channel/session.js";
import type { InstrumentationChannel } from "#shared/instrumentation-channel.js";
import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { SessionSchedule } from "#context/session-schedule.js";
import type { SessionAuth } from "#context/keys.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ScheduleHandlerArgs } from "#public/definitions/schedule.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type {
  Approval,
  ApprovalContext,
  ApprovalStatus,
  ApprovalResponseContext,
  ApprovalResponseDecision,
} from "#approval/definition.js";
import type { MessageContent } from "#shared/message-content.js";
import type { ChannelReference } from "#channel/compiled-channel.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import type { Delivery } from "#shared/delivery.js";
import { SCHEDULE_COLLECTION_DEFINITION_BRAND } from "#shared/schedule-collection-definition.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";
import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";

/** A provider namespace scope, represented by one key or a hierarchical key path. */
export type ScheduleScopeValue = string | readonly string[];
/** Return `null` to deny the current schedule operation. */
export type ScheduleScopeResolverResult = ScheduleScopeValue | null;
export type ScheduleOperation =
  | "create"
  | "get"
  | "list"
  | "update"
  | "enable"
  | "disable"
  | "invoke"
  | "delete";

/** Trusted caller context used to authorize each management operation. */
export interface ScheduleScopeContext {
  readonly abortSignal: AbortSignal;
  readonly operation?: ScheduleOperation;
  readonly name?: string;
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly schedule?: SessionSchedule;
  };
  readonly channel: InstrumentationChannel;
}

/** Stable creator reference; never a snapshot of credentials or permissions. */
export interface SchedulePrincipalReference {
  readonly type: string;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly subject?: string;
}

/** Framework-owned envelope stored alongside timing with the provider. */
export interface ScheduleEnvelope<TPayload = unknown> {
  readonly version: 3;
  readonly payload: TPayload;
  readonly scope: ScheduleScopeValue;
  readonly principal: SchedulePrincipalReference;
}

/** One firing of a schedule, as a provider delivers it. */
export interface ScheduleOccurrence {
  readonly executionId: string;
  readonly name: string;
  readonly scheduleId: string;
  readonly scheduledAt: string;
}

export interface ScheduleOccurrenceIdentity extends ScheduleOccurrence {
  /** Readable schedule label; name remains the unique management identifier. */
  readonly displayName?: string;
  /** Name of the dynamic schedules collection the schedule belongs to. */
  readonly collection: string;
}

/** Callback completion is distinct from completion of the agent sessions it starts. */
export interface ScheduleOccurrenceEvent<TPayload = unknown> {
  readonly type: "occurrence.dispatched" | "occurrence.failed";
  /** @deprecated Use `occurrence.collection`. */
  readonly collection: string;
  /** @deprecated Use `occurrence.executionId`. */
  readonly executionId: string;
  /** @deprecated Use `occurrence.name`. */
  readonly name: string;
  /** @deprecated Use `occurrence.scheduleId`. */
  readonly scheduleId: string;
  /** @deprecated Use `occurrence.scheduledAt`. */
  readonly scheduledAt: string;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly sessionIds?: readonly string[];
  readonly reason?: string;
  readonly schedule?: ScheduleEnvelope<TPayload>;
}

export type ScheduleOccurrenceEventHandler<TPayload = unknown> = (
  event: ScheduleOccurrenceEvent<TPayload>,
) => void | Promise<void>;

export type ScheduleExpression =
  | {
      readonly type: "cron";
      readonly cron: string;
      readonly timezone?: string;
      readonly jitter?: number;
    }
  | { readonly type: "single"; readonly at: string; readonly timezone?: string };
/** Relative delays are resolved once at the client call boundary using eve's clock. */
export type ScheduleTiming =
  | ScheduleExpression
  | { readonly type: "delay"; readonly minutes: number };
export type ScheduleState = "active" | "inactive" | "completed";

/** Provider projection; payload and creator data are not read back. */
export interface ScheduleRecord {
  /** Human-readable label; multiple schedules may share it. */
  readonly displayName?: string;
  readonly createdAt: number;
  readonly expression: ScheduleExpression;
  readonly name: string;
  readonly scheduleId: string;
  readonly state: ScheduleState;
  readonly updatedAt: number;
}
export interface SchedulePage {
  readonly cursor: string | null;
  readonly data: readonly ScheduleRecord[];
}
export interface ScheduleCreate<TPayload> {
  readonly expression: ScheduleExpression;
  readonly payload: TPayload;
  readonly name: string;
}
export interface SchedulePatch<TPayload> {
  readonly expression?: ScheduleExpression;
  readonly payload?: TPayload;
}
export interface ScheduleList {
  readonly cursor?: string;
  readonly limit?: number;
}

/** Storage and occurrence transport supplied by a schedule backend. */
export interface ScheduleProvider {
  readonly kind: string;
  create<TPayload>(
    context: ScheduleProviderContext,
    schedule: ScheduleCreate<TPayload>,
  ): Promise<ScheduleRecord>;
  list(context: ScheduleProviderContext, query: ScheduleList): Promise<SchedulePage>;
  get(context: ScheduleProviderContext, name: string): Promise<ScheduleRecord | null>;
  /** Patch supplied fields; preserve identity, state, target, and omitted fields. */
  update<TPayload>(
    context: ScheduleProviderContext,
    name: string,
    patch: SchedulePatch<TPayload>,
  ): Promise<ScheduleRecord>;
  enable(context: ScheduleProviderContext, name: string): Promise<ScheduleRecord>;
  disable(context: ScheduleProviderContext, name: string): Promise<ScheduleRecord>;
  invoke(context: ScheduleProviderContext, name: string): Promise<void>;
  delete(context: ScheduleProviderContext, name: string): Promise<boolean>;
  /**
   * Throws, or rejects, when the backend can't run `expression`. eve awaits it while it prepares
   * a create or a timing update, so a model's call fails before a person is asked to approve it.
   */
  validateExpression?(expression: ScheduleExpression): void | Promise<void>;
}

export interface ScheduleClientCreate<TPayload> {
  readonly expression: ScheduleTiming;
  /** Display label. Creation allocates a unique management name returned in the receipt. */
  readonly name: string;
  readonly payload: TPayload;
}

/** Requires timing, a complete replacement payload, or both. */
export type ScheduleClientUpdate<TPayload> =
  | { readonly expression: ScheduleTiming; readonly payload?: TPayload }
  | { readonly expression?: ScheduleTiming; readonly payload: TPayload };

/** Authenticated client; every operation is authorized through `scope`. */
export interface ScheduleClient<TPayload> {
  create(input: ScheduleClientCreate<TPayload>): Promise<ScheduleRecord>;
  delete(name: string): Promise<boolean>;
  disable(name: string): Promise<ScheduleRecord>;
  enable(name: string): Promise<ScheduleRecord>;
  get(name: string): Promise<ScheduleRecord | null>;
  invoke(name: string): Promise<void>;
  list(input?: ScheduleList): Promise<SchedulePage>;
  /** Timing-only updates keep the stored payload and creator; payload replacement captures the updating caller as creator. */
  update(name: string, patch: ScheduleClientUpdate<TPayload>): Promise<ScheduleRecord>;
}

/** Starts fresh unattended work bound to the resolved creator; callers cannot choose another identity. */
export type DynamicSchedulesToFn = <TChannel extends ChannelReference<unknown>>(
  channel: TChannel,
  target: InferReceiveTarget<TChannel>,
) => {
  /**
   * Accepts the `to().send()` options that apply to a fresh session. `auth` is
   * the schedule's creator. A send never reaches a session the schedule didn't
   * start, so `turnPolicy` has nothing to act on. A send reaches the session
   * an earlier send from this schedule with the same `idempotencyKey` and
   * target started. Without a key, eve derives one from the occurrence and the
   * message, so a retried callback doesn't start a second session.
   */
  send(
    message: MessageContent,
    options?: Omit<SessionSendOptions, "auth" | "turnPolicy">,
  ): Promise<Delivery>;
};

type SchedulePayloadApprovalRequest<TPrepared> = (
  context: ApprovalContext & { readonly payload: TPrepared },
) => ApprovalStatus | Promise<ApprovalStatus>;
/** Approval policy for a write; its callbacks also receive the prepared payload. */
type SchedulePayloadApproval<TPrepared> =
  | SchedulePayloadApprovalRequest<TPrepared>
  | {
      readonly request: SchedulePayloadApprovalRequest<TPrepared>;
      readonly response?: (
        context: ApprovalResponseContext & { readonly payload: TPrepared },
      ) => ApprovalResponseDecision | Promise<ApprovalResponseDecision>;
    };
/** Approval policy for `create`, which always receives a prepared payload. */
export type ScheduleCreateApproval<TPrepared> = SchedulePayloadApproval<TPrepared>;

export type ScheduleApprovals<TPrepared> = Partial<
  Record<Exclude<ScheduleOperation, "create" | "update">, Approval>
> & {
  readonly create?: ScheduleCreateApproval<TPrepared>;
  /** Prepared replacement payload, or undefined for timing-only updates. */
  readonly update?: SchedulePayloadApproval<TPrepared | undefined>;
};

/** What `auth` returns: the creator's current attributes, a full context for the creator, or `null`. */
export type ScheduleAuthResult = SessionAuthContext | Pick<SessionAuthContext, "attributes"> | null;

/**
 * Controls the schedule that fired an occurrence. Acts without calling `scope`, which authorizes
 * callers, because an occurrence has none.
 */
export interface ScheduleHandle {
  /** Pauses future runs of the schedule that fired this occurrence. */
  disable(): Promise<void>;
  /** Deletes the schedule that fired this occurrence. */
  delete(): Promise<void>;
}

/** Arguments `run` receives for one occurrence. */
export interface DynamicSchedulesRunArgs<TPayload> extends Pick<ScheduleHandlerArgs, "waitUntil"> {
  readonly to: DynamicSchedulesToFn;
  readonly payload: TPayload;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly auth: SessionAuthContext;
  /** The schedule that fired this occurrence. */
  readonly schedule: ScheduleHandle;
}

/** Trusted caller context passed to `scope`, which always names the operation it authorizes. */
export type ScheduleScopeResolverContext = ScheduleScopeContext & {
  readonly operation: ScheduleOperation;
};

/**
 * Trusted caller context passed to `preparePayload`. `name` is the display label on create
 * and the unique management name on update. `expression` tells a recurring schedule from a
 * one-time one, so the payload needn't repeat it.
 */
export type SchedulePreparePayloadContext = ScheduleScopeContext & {
  readonly operation: "create" | "update";
  readonly name: string;
  /**
   * The timing the schedule has after this write: what the caller passed, or the stored timing
   * when an update replaces only the payload. A relative delay is as written, not yet resolved.
   * A timing-only update doesn't prepare again, so a value derived from this keeps the timing it
   * was prepared with.
   */
  readonly expression: ScheduleTiming;
};

/** A dynamic schedules definition, as authored with `defineDynamicSchedules`. */
export interface DynamicSchedulesDefinition<
  TPayload = unknown,
  TSchema extends StandardSchemaV1<unknown, TPayload> = StandardSchemaV1<unknown, TPayload>,
  TPrepared = TPayload,
> {
  /**
   * Stable collection name that overrides the one derived from the module path. Stored schedules
   * belong to this name, so it is persisted identity rather than a label; this is why a
   * collection can override its path-derived name when other definitions can't.
   */
  readonly id?: string;
  readonly description?: string;
  /** Model-facing payload schema. Destination intent may be resolved by `run`. */
  readonly inputSchema: TSchema;
  /** Resolved backend. defineDynamicSchedules defaults omitted providers to Vercel Schedules. */
  readonly provider: ScheduleProvider;
  /**
   * Validates application policy and enriches a creation or replacement payload before the provider write.
   * eve authorizes the write through `scope`, validates caller input with `inputSchema`, then calls
   * `preparePayload` with trusted caller context. eve stores the result's JSON serialization, limited
   * to 64 KB including timing; `inputSchema` describes caller input, not stored prepared output.
   * Throw an actionable error to reject the write without changing a schedule.
   *
   * A common use is capturing the current channel destination: derive channel/workspace
   * references from verified caller context, replace any model-supplied references, and
   * return them with the task. Keep captured fields out of the input schema.
   * Channel-less or delegated callers may lack that context; reject those cases explicitly.
   *
   * Runs on creation and payload replacement. Model calls invoke preparePayload before approval
   * and again before writing; execution fails if the prepared result differs from the approved snapshot.
   * Authenticated clients invoke preparePayload once before writing without model approval.
   * Reads, timing-only updates, state changes, and occurrence execution do not call it. Omission
   * stores validated input unchanged and revalidates it with `inputSchema` at execution. Write
   * retries may call it again, so avoid irreversible side effects. Payload replacement recaptures
   * the destination and creator from the updating caller.
   * `auth`, `run`, and occurrence events receive the inferred return type. Declare `preparePayload`
   * before those callbacks for contextual inference, or annotate its return type explicitly.
   * Prepared application data is not revalidated against the input schema at execution;
   * validate the application's persisted contract in authored code when necessary.
   */
  readonly preparePayload?: (
    payload: TPayload,
    context: SchedulePreparePayloadContext,
  ) => TPrepared | Promise<TPrepared>;
  /** Authorizes every management operation. Defaults to `byPrincipal`. */
  readonly scope?: (
    context: ScheduleScopeResolverContext,
  ) => ScheduleScopeResolverResult | Promise<ScheduleScopeResolverResult>;
  /**
   * Resolves the captured creator to current execution auth. Return `{ attributes }` to run as
   * the stored creator with those attributes, or a full `SessionAuthContext`, whose identity
   * fields must equal the stored creator's. Return `null` to deny: the occurrence fails without
   * a retry. Throw to let the provider retry. A denial fails only this occurrence; to stop later
   * ones too, call `schedule.disable()` or `schedule.delete()` before returning `null`.
   */
  readonly auth: (context: {
    readonly principal: SchedulePrincipalReference;
    readonly payload: NoInfer<TPrepared>;
    readonly occurrence: ScheduleOccurrenceIdentity;
    readonly schedule: ScheduleHandle;
  }) => ScheduleAuthResult | Promise<ScheduleAuthResult>;
  /** May repeat on provider retries. Key external effects on the occurrence identity. */
  readonly run: (args: DynamicSchedulesRunArgs<NoInfer<TPrepared>>) => void | Promise<void>;
  readonly events?: {
    /** After `run` and registered `waitUntil` work succeed; may repeat on retries. */
    readonly "occurrence.dispatched"?: ScheduleOccurrenceEventHandler<NoInfer<TPrepared>>;
    /** On a permanent failure, such as `auth` returning `null`, or after the provider's retry budget is exhausted. */
    readonly "occurrence.failed"?: ScheduleOccurrenceEventHandler<NoInfer<TPrepared>>;
  };
  /** Expose operation tools directly (default true), defer them to the catalog, or disable them. */
  readonly tool?: AgentToolExposure;
  /** Model-call policies keyed by operation. Create and update receive the prepared payload. */
  readonly approval?: ScheduleApprovals<NoInfer<TPrepared>>;
}

export type DefinedDynamicSchedules<
  TPayload = unknown,
  TSchema extends StandardSchemaV1<unknown, TPayload> = StandardSchemaV1<unknown, TPayload>,
  TPrepared = TPayload,
> = DynamicSchedulesDefinition<TPayload, TSchema, TPrepared> & {
  readonly [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true;
};

type DynamicSchedulesOptions<
  TInput,
  TSchema extends StandardSchemaV1<unknown, TInput>,
  TPrepared = TInput,
> = Omit<
  DynamicSchedulesDefinition<TInput, TSchema, TPrepared>,
  "provider" | "tool" | "approval"
> & {
  /** Defaults to vercelScheduleProvider(): hosted production scheduling, process-local storage in eve dev. */
  readonly provider?: ScheduleProvider;
} & (
    | { readonly tool: false; readonly approval?: never }
    | {
        readonly tool?: true | "deferred";
        readonly approval?: ScheduleApprovals<NoInfer<TPrepared>>;
      }
  );

/**
 * Defines dynamic schedules: schedules created at runtime whose occurrences invoke `run`.
 * Export the definition from a module in `agent/schedules/`; its name comes from `id`, or the
 * module path when `id` is omitted. `inputSchema` validates caller input, while eve captures the
 * creator separately and re-resolves it through `auth` on every attempt. `run` chooses destinations and starts work; the creating
 * conversation is not captured. `provider` defaults to `vercelScheduleProvider()`, which supports
 * Vercel deployments and `eve dev`, not self-hosted scheduling.
 */
export function defineDynamicSchedules<TInput, TPrepared>(
  definition: Omit<
    DynamicSchedulesOptions<TInput, StandardSchemaV1<unknown, TInput>, TPrepared>,
    "preparePayload"
  > & {
    readonly preparePayload: (
      payload: TInput,
      context: SchedulePreparePayloadContext,
    ) => TPrepared | Promise<TPrepared>;
  },
): DefinedDynamicSchedules<TInput, StandardSchemaV1<unknown, TInput>, TPrepared>;
export function defineDynamicSchedules<TSchema extends StandardSchemaV1<unknown, unknown>>(
  definition: ExactDefinition<
    DynamicSchedulesOptions<StandardSchemaV1.InferOutput<TSchema>, TSchema>,
    DynamicSchedulesOptions<StandardSchemaV1.InferOutput<TSchema>, TSchema>
  >,
): DefinedDynamicSchedules<StandardSchemaV1.InferOutput<TSchema>, TSchema>;
export function defineDynamicSchedules(
  definition: Omit<DynamicSchedulesDefinition<any, any, any>, "provider"> & {
    readonly provider?: ScheduleProvider;
  },
): DefinedDynamicSchedules<any, any, any> {
  Object.assign(definition, {
    provider: definition.provider ?? vercelScheduleProvider(),
    tool: definition.tool ?? true,
    [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true,
  });
  return definition as DefinedDynamicSchedules<any, any, any>;
}
