import { createHash, randomUUID } from "node:crypto";

import type { SessionAuth } from "#context/keys.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleCreate,
  ScheduleDelivery,
  ScheduleList,
  SchedulePatch,
  ScheduleProviderContext,
  ScheduleRecord,
  ScheduleScopeContext,
} from "#public/schedules/collection.js";
import {
  validateScheduleExpression,
  validateScheduleListLimit,
  validateScheduleName,
} from "#runtime/schedules/validation.js";

export interface ScheduleCollectionBindingContext extends ScheduleScopeContext {
  readonly application: string;
  readonly operationId?: () => string;
  readonly targetKey?: string;
}

export interface BoundScheduleCollection<TInput> {
  create(input: ScheduleCreate<TInput>): Promise<ScheduleRecord>;
  delete(name: string): Promise<boolean>;
  disable(name: string): Promise<ScheduleRecord>;
  enable(name: string): Promise<ScheduleRecord>;
  get(name: string): Promise<ScheduleRecord | null>;
  invoke(name: string): Promise<void>;
  list(input?: ScheduleList): Promise<import("#public/schedules/collection.js").SchedulePage>;
  update(name: string, patch: SchedulePatch<TInput>): Promise<ScheduleRecord>;
}

export async function bindScheduleCollection<TInput>(
  collection: string,
  definition: ScheduleCollectionDefinition<TInput>,
  binding: ScheduleCollectionBindingContext,
  deliver?: (delivery: ScheduleDelivery<TInput>) => Promise<void>,
): Promise<BoundScheduleCollection<TInput> | null> {
  const scope = await resolveScope(definition.scope, binding);
  if (scope === null) return null;
  const namespace = deriveScheduleNamespace(binding.application, collection, scope);
  const nextOperationId = binding.operationId ?? randomUUID;
  const providerContext = (): ScheduleProviderContext => {
    const target: {
      key: string;
      deliver?: (value: ScheduleDelivery<any>) => Promise<void>;
    } = { key: binding.targetKey ?? collection };
    if (deliver !== undefined) target.deliver = deliver;
    return {
      abortSignal: binding.abortSignal,
      collection,
      namespace,
      operationId: nextOperationId(),
      target,
    };
  };
  const provider = definition.provider;

  return {
    create: async (input) =>
      provider.create(providerContext(), {
        ...input,
        expression: validateScheduleExpression(input.expression),
        input: await validateCollectionInput(definition, input.input),
        name: validateScheduleName(input.name),
      }),
    delete: async (name) => provider.delete(providerContext(), validateScheduleName(name)),
    disable: async (name) => provider.disable(providerContext(), validateScheduleName(name)),
    enable: async (name) => provider.enable(providerContext(), validateScheduleName(name)),
    get: async (name) => provider.get(providerContext(), validateScheduleName(name)),
    invoke: async (name) => provider.invoke(providerContext(), validateScheduleName(name)),
    list: async (input = {}) => {
      const limit = validateScheduleListLimit(input.limit);
      const cursor = input.cursor?.trim() || undefined;
      let normalized: ScheduleList = {};
      if (cursor !== undefined) normalized = { ...normalized, cursor };
      if (limit !== undefined) normalized = { ...normalized, limit };
      return provider.list(providerContext(), normalized);
    },
    update: async (name, patch) => {
      const normalizedName = validateScheduleName(name);
      const expression =
        patch.expression === undefined ? undefined : validateScheduleExpression(patch.expression);
      if (expression !== undefined) {
        const current = await provider.get(providerContext(), normalizedName);
        if (current !== null && current.expression.type !== expression.type) {
          throw new Error("A schedule cannot change between recurring and one-time expressions.");
        }
      }
      const input =
        patch.input === undefined
          ? undefined
          : await validateCollectionInput(definition, patch.input);
      let normalized: SchedulePatch<TInput> = {};
      if (expression !== undefined) normalized = { ...normalized, expression };
      if (input !== undefined) normalized = { ...normalized, input };
      return provider.update(providerContext(), normalizedName, normalized);
    },
  };
}

export function createScheduleScopeContext(input: {
  readonly abortSignal: AbortSignal;
  readonly auth: SessionAuth;
  readonly channel?: ScheduleScopeContext["channel"];
  readonly sessionId: string;
}): ScheduleScopeContext {
  return {
    abortSignal: input.abortSignal,
    channel: input.channel ?? {},
    session: { auth: input.auth, id: input.sessionId },
  };
}

function deriveScheduleNamespace(
  application: string,
  collection: string,
  scope: string | readonly string[],
): string {
  if (application.trim().length === 0) throw new Error("Schedule application must not be empty.");
  const digest = createHash("sha256")
    .update(JSON.stringify(["eve-schedule-namespace-v1", application, collection, scope]))
    .digest("base64url");
  return `eve-${digest}`;
}

async function validateCollectionInput<TInput>(
  definition: ScheduleCollectionDefinition<TInput>,
  input: TInput,
): Promise<TInput> {
  const result = await definition.inputSchema["~standard"].validate(input);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid schedule input${details ? `: ${details}` : "."}`);
  }
  return result.value;
}

async function resolveScope(
  definition: ScheduleCollectionDefinition["scope"],
  context: ScheduleScopeContext,
): Promise<string | readonly string[] | null> {
  const scope = typeof definition === "function" ? await definition(context) : definition;
  if (scope === null) return null;
  if (typeof scope === "string") {
    if (scope.length === 0) throw new Error("Schedule scope must not be empty.");
    return scope;
  }
  if (scope.length === 0 || scope.some((component) => component.length === 0)) {
    throw new Error("Schedule scope components must not be empty.");
  }
  return scope;
}
