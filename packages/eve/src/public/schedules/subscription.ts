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
import type { UserContent } from "ai";
import type { ChannelReference } from "#channel/compiled-channel.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import type { Session } from "#channel/session.js";
import { SCHEDULE_COLLECTION_DEFINITION_BRAND } from "#shared/schedule-collection-definition.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
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
  readonly channel: {
    readonly kind?: string;
    readonly continuationToken?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
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

export interface ScheduleOccurrenceIdentity {
  /** Readable schedule label; name remains the unique management identifier. */
  readonly displayName?: string;
  readonly collection: string;
  readonly scheduleId: string;
  readonly name: string;
  readonly executionId: string;
  readonly scheduledAt: string;
}

/** Callback completion is distinct from completion of the agent sessions it starts. */
export interface ScheduleOccurrenceEvent<TPayload = unknown> {
  readonly type: "occurrence.dispatched" | "occurrence.failed";
  readonly collection: string;
  readonly executionId: string;
  readonly name: string;
  readonly scheduleId: string;
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
export interface ScheduleOccurrence {
  readonly executionId: string;
  readonly name: string;
  readonly scheduleId: string;
  readonly scheduledAt: string;
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
}

export interface ScheduleClientCreate<TPayload> {
  readonly expression: ScheduleTiming;
  /** Display label. Creation allocates a unique management name returned in the receipt. */
  readonly name: string;
  readonly payload: TPayload;
}
export interface SchedulePageResult {
  readonly cursor: string | null;
  readonly data: readonly ScheduleRecord[];
}

/** Requires timing or complete replacement input, which captures the updating caller as creator. */
export type ScheduleClientUpdate<TPayload> =
  | { readonly expression: ScheduleTiming; readonly payload?: TPayload }
  | { readonly expression?: ScheduleTiming; readonly payload: TPayload };

/** Authenticated client; timing-only updates preserve payload and creator identity. */
export interface ScheduleClient<TPayload> {
  create(input: ScheduleClientCreate<TPayload>): Promise<ScheduleRecord>;
  delete(name: string): Promise<boolean>;
  disable(name: string): Promise<ScheduleRecord>;
  enable(name: string): Promise<ScheduleRecord>;
  get(name: string): Promise<ScheduleRecord | null>;
  invoke(name: string): Promise<void>;
  list(input?: ScheduleList): Promise<SchedulePageResult>;
  /** Requires timing or payload. Payload replacement captures the updating caller as creator. */
  update(name: string, patch: ScheduleClientUpdate<TPayload>): Promise<ScheduleRecord>;
}

/** Starts fresh unattended work bound to the resolved creator; callers cannot choose another identity. */
export type DynamicSchedulesToFn = <TChannel extends ChannelReference<unknown>>(
  channel: TChannel,
  target: InferReceiveTarget<TChannel>,
) => { send(message: string | UserContent): Promise<Session> };

type SchedulePayloadApproval<TPrepared> =
  | ((
      context: ApprovalContext & { readonly payload: TPrepared },
    ) => ApprovalStatus | Promise<ApprovalStatus>)
  | {
      readonly request: (
        context: ApprovalContext & { readonly payload: TPrepared },
      ) => ApprovalStatus | Promise<ApprovalStatus>;
      readonly response?: (
        context: ApprovalResponseContext & { readonly payload: TPrepared },
      ) => ApprovalResponseDecision | Promise<ApprovalResponseDecision>;
    };
export type ScheduleCreateApproval<TPrepared> = SchedulePayloadApproval<TPrepared>;

export type ScheduleApprovals<TPrepared> = Partial<
  Record<Exclude<ScheduleOperation, "create" | "update">, Approval>
> & {
  readonly create?: ScheduleCreateApproval<TPrepared>;
  /** Prepared replacement payload, or undefined for timing-only updates. */
  readonly update?: SchedulePayloadApproval<TPrepared | undefined>;
};

/** Execution context; `to` starts fresh, unattended sessions as the resolved creator. */
export interface DynamicSchedulesRunArgs<TPayload> extends Pick<ScheduleHandlerArgs, "waitUntil"> {
  readonly to: DynamicSchedulesToFn;
  readonly payload: TPayload;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly auth: SessionAuthContext;
}

/** Defines dynamically created schedules whose occurrences invoke authored code. */
export interface DynamicSchedulesDefinition<
  TPayload = unknown,
  TSchema extends StandardSchemaV1<unknown, TPayload> = StandardSchemaV1<unknown, TPayload>,
  TPrepared = TPayload,
> {
  readonly description?: string;
  /** Model-facing payload schema. Destination intent may be resolved by `run`. */
  readonly inputSchema: TSchema;
  /** Resolved backend. defineDynamicSchedules defaults omitted providers to Vercel Schedules. */
  readonly provider: ScheduleProvider;
  /**
   * Validates application policy and enriches a creation or replacement payload before the provider write.
   * The caller constructs input; eve validates it with `inputSchema`, authorizes the write
   * through `scope`, then calls `preparePayload` with trusted caller context. eve checks that the
   * result is bounded JSON and persists it; `inputSchema` describes caller input, not stored prepared output.
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
   * stores validated input unchanged. Write retries may call it again, so avoid irreversible
   * side effects. Payload replacement recaptures the destination and creator from the updating caller.
   * `auth`, `run`, and occurrence events receive the inferred return type. Declare `preparePayload`
   * before those callbacks for contextual inference, or annotate its return type explicitly.
   * Prepared application data is not revalidated against the input schema at execution;
   * validate the application's persisted contract in authored code when necessary.
   */
  readonly preparePayload?: (
    payload: TPayload,
    context: ScheduleScopeContext & {
      readonly operation: "create" | "update";
      readonly name: string;
    },
  ) => TPrepared | Promise<TPrepared>;
  /** Authorizes every management operation. Defaults to `byPrincipal`. */
  readonly scope?: (
    context: ScheduleScopeContext & { readonly operation: ScheduleOperation },
  ) => ScheduleScopeResolverResult | Promise<ScheduleScopeResolverResult>;
  /** Resolves the captured creator to current execution auth; return `null` to deny. */
  readonly auth: (context: {
    readonly principal: SchedulePrincipalReference;
    readonly payload: NoInfer<TPrepared>;
    readonly occurrence: ScheduleOccurrenceIdentity;
  }) => SessionAuthContext | null | Promise<SessionAuthContext | null>;
  /** May repeat on provider retries. Key external effects on the occurrence identity. */
  readonly run: (args: DynamicSchedulesRunArgs<NoInfer<TPrepared>>) => void | Promise<void>;
  readonly events?: {
    /** After `run` and registered `waitUntil` work succeed; may repeat on retries. */
    readonly "occurrence.dispatched"?: ScheduleOccurrenceEventHandler<NoInfer<TPrepared>>;
    /** On a permanent provider failure or after its retry budget is exhausted. */
    readonly "occurrence.failed"?: ScheduleOccurrenceEventHandler<NoInfer<TPrepared>>;
  };
  /** Expose operation tools directly (default true), or false for code-only scheduling. */
  readonly tool?: boolean;
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
    | { readonly tool?: true; readonly approval?: ScheduleApprovals<NoInfer<TPrepared>> }
  );

/**
 * Defines a dynamic schedule subscription. Export it from `agent/schedules/`;
 * identity comes from the module path. inputSchema validates caller input,
 * while eve captures creator identity separately and re-resolves it on every attempt.
 * `run` chooses destinations and starts work; no creation conversation is implicitly captured.
 * Provider defaults to vercelScheduleProvider(); pass provider explicitly to select another backend.
 * The default supports Vercel production and eve dev, not preview or self-hosted scheduling.
 */
export function defineDynamicSchedules<TInput, TPrepared>(
  definition: Omit<
    DynamicSchedulesOptions<TInput, StandardSchemaV1<unknown, TInput>, TPrepared>,
    "preparePayload"
  > & {
    readonly preparePayload: (
      payload: TInput,
      context: ScheduleScopeContext & {
        readonly operation: "create" | "update";
        readonly name: string;
      },
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
