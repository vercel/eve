import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { SessionAuth } from "#context/keys.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { ScheduleHandlerArgs } from "#public/definitions/schedule.js";
import { SCHEDULE_COLLECTION_DEFINITION_BRAND } from "#shared/schedule-collection-definition.js";

export type ScheduleScopeResolverResult = string | readonly string[] | null;

export interface ScheduleScopeContext {
  readonly abortSignal: AbortSignal;
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
  };
  readonly channel: {
    readonly kind?: string;
    readonly continuationToken?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

export type ScheduleScopeDefinition =
  | string
  | null
  | ((
      context: ScheduleScopeContext,
    ) => ScheduleScopeResolverResult | Promise<ScheduleScopeResolverResult>);

/** Trusted context available while resolving schedule input for storage. */
export interface ScheduleCollectionPayloadResolveContext {
  readonly abortSignal: AbortSignal;
  readonly auth: SessionAuth;
  readonly channel: ScheduleScopeContext["channel"];
}

export interface ScheduleProviderContext {
  readonly abortSignal: AbortSignal;
  readonly collection: string;
  readonly namespace: string;
  readonly operationId: string;
  readonly target: ScheduleDeliveryTarget;
}

export interface ScheduleDelivery<TPayload = unknown> {
  readonly payload: TPayload;
  readonly occurrence: ScheduleOccurrence;
}

export interface ScheduleDeliveryTarget {
  readonly key: string;
  readonly deliver?: (delivery: ScheduleDelivery<any>) => Promise<void>;
}

export type ScheduleExpression =
  | {
      readonly type: "cron";
      readonly cron: string;
      readonly timezone?: string;
      readonly jitter?: number;
    }
  | {
      readonly type: "single";
      readonly at: string;
      readonly timezone?: string;
    };

export type ScheduleState = "active" | "inactive";

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

export interface ScheduleOccurrence {
  readonly executionId: string;
  readonly name: string;
  readonly scheduleId: string;
  readonly scheduledAt: string;
}

export interface ScheduleCollectionRunArgs<TPayload> extends ScheduleHandlerArgs {
  readonly payload: TPayload;
  readonly occurrence: ScheduleOccurrence;
}

export interface ScheduleCollectionToolOptions {
  readonly create?: boolean;
  readonly delete?: boolean;
  readonly invoke?: boolean;
  readonly read?: boolean;
  readonly update?: boolean;
}

export interface ScheduleCollectionDefinition<
  TPayload = unknown,
  TPayloadSchema extends StandardSchemaV1<unknown, TPayload> = StandardSchemaV1<unknown, TPayload>,
> {
  readonly description?: string;
  readonly payloadSchema: TPayloadSchema;
  readonly provider: ScheduleProvider;
  readonly scope: ScheduleScopeDefinition;
  /** Resolve validated payload with trusted creation context before storing it. */
  readonly resolvePayload?: (
    payload: TPayload,
    context: ScheduleCollectionPayloadResolveContext,
  ) => TPayload | Promise<TPayload>;
  readonly tools?: boolean | ScheduleCollectionToolOptions;
  readonly run: (args: ScheduleCollectionRunArgs<TPayload>) => Promise<void> | void;
}

export type DefinedScheduleCollection<
  T extends ScheduleCollectionDefinition<any, any> = ScheduleCollectionDefinition,
> = T & {
  readonly [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true;
};

export function defineScheduleCollection<TPayloadSchema extends StandardSchemaV1<unknown, unknown>>(
  definition: ExactDefinition<
    ScheduleCollectionDefinition<StandardSchemaV1.InferOutput<TPayloadSchema>, TPayloadSchema>,
    ScheduleCollectionDefinition<StandardSchemaV1.InferOutput<TPayloadSchema>, TPayloadSchema>
  >,
): DefinedScheduleCollection<
  ScheduleCollectionDefinition<StandardSchemaV1.InferOutput<TPayloadSchema>, TPayloadSchema>
>;
export function defineScheduleCollection(
  definition: ScheduleCollectionDefinition,
): DefinedScheduleCollection {
  Object.assign(definition, { [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true });
  return definition as DefinedScheduleCollection;
}
