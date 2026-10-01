import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { SessionAuth } from "#context/keys.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { Approval } from "#public/definitions/approval.js";
import type { ScheduleDeliveryDefinition } from "#public/schedules/delivery.js";
import type { JsonValue } from "#shared/json.js";
import { SCHEDULE_COLLECTION_DEFINITION_BRAND } from "#shared/schedule-collection-definition.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";

/** A provider namespace scope, represented by one key or a hierarchical key path. */
export type ScheduleScopeValue = string | readonly string[];
/** Return `null` to deny the current schedule operation. */
export type ScheduleScopeResolverResult = ScheduleScopeValue | null;
/** Schedule operation being authorized by a collection's scope resolver. */
export type ScheduleOperation =
  | "create"
  | "get"
  | "list"
  | "update"
  | "enable"
  | "disable"
  | "invoke"
  | "delete";

export type ScheduleDeliveryMode = "thread" | "channel";

/** Context available to scope resolvers and delivery `capture` hooks. */
export interface ScheduleScopeContext {
  /** Signal for the current schedule-management operation. */
  readonly abortSignal: AbortSignal;
  /** Operation being authorized; required when passed to the `scope` resolver. */
  readonly operation?: ScheduleOperation;
  /** Schedule name for name-specific operations, when available. */
  readonly name?: string;
  /** Authenticated session making the current operation. */
  readonly session: { readonly id: string; readonly auth: SessionAuth };
  /** Channel context that may expose trusted destination-capture capabilities. */
  readonly channel: {
    /** Registered channel kind, when the operation came from a channel. */
    readonly kind?: string;
    /** Current channel continuation token, when available. */
    readonly continuationToken?: string;
    /** Metadata supplied by the current channel. */
    readonly metadata?: Readonly<Record<string, unknown>>;
    /** Captures the current channel destination, optionally as a thread or channel. */
    readonly currentTarget: (mode?: ScheduleDeliveryMode) => ScheduleChannelTarget;
    /** Mints a personal destination for the authenticated creator. */
    readonly mintPersonalTarget: () => Promise<ScheduleChannelTarget>;
  };
}

/** Stable, serializable reference to the principal that created a schedule. */
export interface SchedulePrincipalReference {
  readonly type: string;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly subject?: string;
}

/** Channel destination captured from the current conversation, for use in a delivery's `binding`. */
export interface ScheduleChannelTarget {
  readonly channel: string;
  readonly continuationToken: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly delivery: "channel" | "personal";
  readonly recipient?: Readonly<Record<string, string>>;
}

/** Request and creator data stored with a provider payload for later execution. */
export interface ScheduleEnvelope<TRequest = unknown, TMetadata = unknown> {
  readonly version: 2;
  readonly request: TRequest;
  readonly scope: ScheduleScopeValue;
  readonly principal: SchedulePrincipalReference;
  readonly metadata: TMetadata;
  /** Deliveries selected at creation, keyed by name, with their captured bindings. */
  readonly deliveries: Readonly<Record<string, ScheduleDeliveryBinding>>;
}

/** What one delivery's `capture` recorded at creation. */
export interface ScheduleDeliveryBinding {
  readonly label?: string;
  readonly binding?: JsonValue;
}

/** Provider identity and timing information for one delivered occurrence. */
export interface ScheduleOccurrenceIdentity {
  readonly collection: string;
  readonly scheduleId: string;
  readonly name: string;
  readonly executionId: string;
  readonly scheduledAt: string;
}

/** Lifecycle notification emitted when an occurrence is admitted or fails before admission. */
export interface ScheduleOccurrenceEvent<TRequest = unknown, TMetadata = unknown> {
  readonly type: "occurrence.admitted" | "occurrence.failed";
  readonly collection: string;
  readonly executionId: string;
  readonly name: string;
  readonly scheduleId: string;
  readonly scheduledAt: string;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly sessionId?: string;
  readonly reason?: string;
  readonly schedule?: ScheduleEnvelope<TRequest, TMetadata>;
}

/** Observer called for one schedule occurrence lifecycle event. */
export type ScheduleOccurrenceEventHandler<TRequest = unknown, TMetadata = unknown> = (
  event: ScheduleOccurrenceEvent<TRequest, TMetadata>,
) => void | Promise<void>;

/** Outcome of one delivery for one occurrence. */
export interface ScheduleDeliveryEvent {
  readonly type: "delivery.succeeded" | "delivery.failed";
  readonly collection: string;
  /** Delivery name, as chosen at creation. */
  readonly delivery: string;
  readonly executionId: string;
  readonly name: string;
  readonly occurrence: ScheduleOccurrenceIdentity;
  /** Why the delivery failed; present only for `delivery.failed`. */
  readonly reason?: string;
  readonly scheduleId: string;
  readonly scheduledAt: string;
  readonly sessionId: string;
}

/** Observer called once for each delivery outcome. Failures inside it are logged, not retried. */
export type ScheduleDeliveryEventHandler = (event: ScheduleDeliveryEvent) => void | Promise<void>;
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
  | {
      readonly type: "delay";
      readonly minutes: number;
    };
export type ScheduleState = "active" | "inactive" | "completed";

/** Public/provider projection; request content and delivery bindings are never read back. */
export interface ScheduleRecord {
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
  readonly state?: ScheduleState;
}
export interface ScheduleList {
  readonly cursor?: string;
  readonly limit?: number;
}
export interface SchedulePatch<TPayload> {
  readonly expression?: ScheduleExpression;
  readonly payload?: TPayload;
}
export interface ScheduleOccurrence {
  readonly executionId: string;
  readonly name: string;
  readonly scheduleId: string;
  readonly scheduledAt: string;
}

/** Storage and dispatch operations implemented by a schedule collection provider. */
export interface ScheduleProvider {
  readonly kind: string;
  create<TPayload>(
    context: ScheduleProviderContext,
    schedule: ScheduleCreate<TPayload>,
  ): Promise<ScheduleRecord>;
  list(context: ScheduleProviderContext, query: ScheduleList): Promise<SchedulePage>;
  get(context: ScheduleProviderContext, name: string): Promise<ScheduleRecord | null>;
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

export interface ScheduleClientCreate<TRequest, TMetadata> {
  /** Names of the collection's configured deliveries; at least one is required. */
  readonly deliveries: readonly string[];
  readonly expression: ScheduleTiming;
  readonly name: string;
  readonly request: TRequest;
  readonly metadata?: TMetadata;
}
export interface SchedulePageResult {
  readonly cursor: string | null;
  readonly data: readonly ScheduleRecord[];
}
/** A created schedule with the labels its deliveries captured. Bindings are never returned. */
export interface ScheduleCreated extends ScheduleRecord {
  readonly deliveries: readonly { readonly name: string; readonly label?: string }[];
}

/** Authenticated management client for schedules in one collection and scope. */
export interface ScheduleClient<TRequest, TMetadata> {
  create(input: ScheduleClientCreate<TRequest, TMetadata>): Promise<ScheduleCreated>;
  delete(name: string): Promise<boolean>;
  disable(name: string): Promise<ScheduleRecord>;
  enable(name: string): Promise<ScheduleRecord>;
  get(name: string): Promise<ScheduleRecord | null>;
  invoke(name: string): Promise<void>;
  list(input?: ScheduleList): Promise<SchedulePageResult>;
  update(name: string, patch: { readonly expression?: ScheduleTiming }): Promise<ScheduleRecord>;
}

/**
 * Configuration for one dynamic schedule collection. Export a value created by
 * {@link defineScheduleCollection} from a file under `agent/schedules/`.
 *
 * Each operation is authorized by `scope`; by default, schedules are isolated
 * by the authenticated principal. The provider stores schedule timing and an
 * opaque payload, while eve validates the request and metadata, starts a fresh
 * session for each delivered occurrence, and runs the schedule's selected
 * `deliveries` once the occurrence settles.
 *
 * @typeParam TRequest - Validated request data captured at schedule creation.
 * @typeParam TMetadata - Validated application metadata captured at creation.
 */
export interface ScheduleCollectionDefinition<
  TRequest = string,
  TMetadata = Readonly<Record<string, never>>,
> {
  /** Description used for the generated schedule-management tools. */
  readonly description?: string;
  /** Provider used to persist schedules and deliver their occurrences. */
  readonly provider: ScheduleProvider;
  /**
   * Resolves the namespace used for this operation. Return `null` to deny it.
   * Defaults to `byPrincipal`, which isolates schedules by the caller's
   * principal; a custom resolver can implement application-specific ownership.
   */
  readonly scope?: (
    context: ScheduleScopeContext & { readonly operation: ScheduleOperation },
  ) => ScheduleScopeResolverResult | Promise<ScheduleScopeResolverResult>;
  /** Validates and transforms the request captured at creation; defaults to a bounded string schema. */
  readonly request?: StandardSchemaV1<unknown, TRequest>;
  /** Validates and transforms application metadata; defaults to an empty object schema. */
  readonly metadata?: StandardSchemaV1<unknown, TMetadata>;
  /**
   * Where results can go, keyed by delivery name. Every schedule is created
   * with one or more of these names and, after each occurrence settles, eve
   * runs the selected deliveries. There is no default and no way to create a
   * schedule without one. Names must match `^[a-z][a-z0-9-]{0,63}$`.
   */
  readonly deliveries: Readonly<Record<string, ScheduleDeliveryDefinition<any>>>;
  /**
   * Resolves the captured creator to execution auth when an occurrence fires,
   * and again before every delivery attempt. Return `null` to deny.
   */
  readonly auth: (context: {
    readonly principal: SchedulePrincipalReference;
    readonly metadata: TMetadata;
    readonly occurrence: ScheduleOccurrenceIdentity;
  }) => SessionAuthContext | null | Promise<SessionAuthContext | null>;
  /** Occurrence lifecycle observers. A failure event covers failures before admission. */
  readonly events?: {
    /** Called when eve has admitted the occurrence to a session; may be replayed on recovery. */
    readonly "occurrence.admitted"?: ScheduleOccurrenceEventHandler<TRequest, TMetadata>;
    /** Called when the occurrence fails before a session is admitted. */
    readonly "occurrence.failed"?: ScheduleOccurrenceEventHandler<TRequest, TMetadata>;
    /** Called when a delivery succeeds; may repeat if the session step is replayed. */
    readonly "delivery.succeeded"?: ScheduleDeliveryEventHandler;
    /** Called when a delivery fails permanently, including when its turn failed. */
    readonly "delivery.failed"?: ScheduleDeliveryEventHandler;
  };
  /**
   * Configure generated management tools, or set to `false` to omit them.
   * By default, get/list require no approval; create, update, enable, disable,
   * invoke, and delete require user approval. Overrides affect only the
   * generated tool, not scope authorization or future occurrence tools.
   */
  readonly tools?: false | { readonly approval?: Partial<Record<ScheduleOperation, Approval>> };
}

/** A collection definition carrying the marker required by eve's compiler. */
export type DefinedScheduleCollection<
  TRequest = string,
  TMetadata = Readonly<Record<string, never>>,
> = ScheduleCollectionDefinition<TRequest, TMetadata> & {
  readonly [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true;
};

/**
 * Defines a dynamic schedule collection for an `agent/schedules/` module.
 * The definition object is marked in place for compiler discovery; collection
 * identity comes from the module path, not from a `name` property.
 *
 * @typeParam TRequest - Validated request data captured when a schedule is created.
 * @typeParam TMetadata - Validated application metadata captured at creation.
 * @param definition - Provider and policies for this collection.
 * @returns The same definition, marked as a schedule collection.
 *
 * @example A principal-scoped collection that archives each result
 * ```ts
 * import {
 *   defineScheduleCollection,
 *   defineScheduleDelivery,
 * } from "eve/experimental/schedules";
 * import { vercelScheduleProvider } from "eve/experimental/schedules/vercel";
 * import { resolveCurrentUser } from "../lib/identity";
 *
 * export default defineScheduleCollection({
 *   provider: vercelScheduleProvider(),
 *   auth: ({ principal }) => resolveCurrentUser(principal),
 *   deliveries: {
 *     "team-archive": defineScheduleDelivery({
 *       description: "Archive the full report as markdown in the team bucket.",
 *       deliver: ({ content, occurrence }) => putObject(`reports/${occurrence.executionId}.md`, content),
 *     }),
 *   },
 * });
 * ```
 */
export function defineScheduleCollection<
  TRequest = string,
  TMetadata = Readonly<Record<string, never>>,
>(
  definition: ExactDefinition<
    ScheduleCollectionDefinition<TRequest, TMetadata>,
    ScheduleCollectionDefinition<TRequest, TMetadata>
  >,
): DefinedScheduleCollection<TRequest, TMetadata> {
  Object.assign(definition, { [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true });
  return definition as DefinedScheduleCollection<TRequest, TMetadata>;
}
