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

export interface ScheduleProviderContext {
  readonly abortSignal: AbortSignal;
  readonly collection: string;
  readonly namespace: string;
  readonly operationId: string;
  readonly target: ScheduleDeliveryTarget;
}

export interface ScheduleDeliveryTarget {
  readonly key: string;
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

export interface ScheduleCreate<TInput> {
  readonly expression: ScheduleExpression;
  readonly input: TInput;
  readonly name: string;
  readonly state?: ScheduleState;
}

export interface ScheduleList {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SchedulePatch<TInput> {
  readonly expression?: ScheduleExpression;
  readonly input?: TInput;
}

export interface ScheduleProvider {
  create<TInput>(
    context: ScheduleProviderContext,
    input: ScheduleCreate<TInput>,
  ): Promise<ScheduleRecord>;
  list(context: ScheduleProviderContext, input: ScheduleList): Promise<SchedulePage>;
  get(context: ScheduleProviderContext, name: string): Promise<ScheduleRecord | null>;
  update<TInput>(
    context: ScheduleProviderContext,
    name: string,
    patch: SchedulePatch<TInput>,
  ): Promise<ScheduleRecord>;
  enable(context: ScheduleProviderContext, name: string): Promise<ScheduleRecord>;
  disable(context: ScheduleProviderContext, name: string): Promise<ScheduleRecord>;
  invoke(context: ScheduleProviderContext, name: string): Promise<void>;
  delete(context: ScheduleProviderContext, name: string): Promise<boolean>;
}

export interface ScheduleOccurrence {
  readonly firedAt: string;
  readonly id: string;
  readonly name: string;
  readonly scheduleId: string;
}

export interface ScheduleCollectionRunArgs<TInput> extends ScheduleHandlerArgs {
  readonly input: TInput;
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
  TInput = unknown,
  TInputSchema extends StandardSchemaV1<unknown, TInput> = StandardSchemaV1<unknown, TInput>,
> {
  readonly description?: string;
  readonly inputSchema: TInputSchema;
  readonly provider: ScheduleProvider;
  readonly scope: ScheduleScopeDefinition;
  readonly tools?: boolean | ScheduleCollectionToolOptions;
  readonly run: (args: ScheduleCollectionRunArgs<TInput>) => Promise<void> | void;
}

export type DefinedScheduleCollection<
  T extends ScheduleCollectionDefinition<any, any> = ScheduleCollectionDefinition,
> = T & {
  readonly [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true;
};

export function defineScheduleCollection<TInputSchema extends StandardSchemaV1<unknown, unknown>>(
  definition: ExactDefinition<
    ScheduleCollectionDefinition<StandardSchemaV1.InferOutput<TInputSchema>, TInputSchema>,
    ScheduleCollectionDefinition<StandardSchemaV1.InferOutput<TInputSchema>, TInputSchema>
  >,
): DefinedScheduleCollection<
  ScheduleCollectionDefinition<StandardSchemaV1.InferOutput<TInputSchema>, TInputSchema>
>;
export function defineScheduleCollection(
  definition: ScheduleCollectionDefinition,
): DefinedScheduleCollection {
  Object.assign(definition, { [SCHEDULE_COLLECTION_DEFINITION_BRAND]: true });
  return definition as DefinedScheduleCollection;
}
