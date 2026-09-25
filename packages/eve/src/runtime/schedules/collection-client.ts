import { createHash, randomUUID } from "node:crypto";

import type { SessionAuth } from "#context/keys.js";
import { captureSlackActionContext } from "#public/experimental/slack/action-context.js";
import {
  createSchedulePayload,
  type ScheduleCollectionPayload,
} from "#runtime/schedules/payload.js";
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

export const MAX_SCHEDULES_PER_DELETE = 25;

export type ScheduleDeleteResult = {
  readonly name: string;
  readonly status: "deleted" | "not-found" | "failed";
};

export interface BoundScheduleCollection {
  create(input: ScheduleCreate<string>): Promise<ScheduleRecord>;
  delete(names: readonly string[]): Promise<readonly ScheduleDeleteResult[]>;
  disable(name: string): Promise<ScheduleRecord>;
  enable(name: string): Promise<ScheduleRecord>;
  get(name: string): Promise<ScheduleRecord | null>;
  invoke(name: string): Promise<void>;
  list(input?: ScheduleList): Promise<import("#public/schedules/collection.js").SchedulePage>;
  update(name: string, patch: SchedulePatch<string>): Promise<ScheduleRecord>;
}

export async function bindScheduleCollection(
  collection: string,
  definition: ScheduleCollectionDefinition,
  binding: ScheduleCollectionBindingContext,
  deliver?: (delivery: ScheduleDelivery<ScheduleCollectionPayload>) => Promise<void>,
): Promise<BoundScheduleCollection | null> {
  const scope = await resolveScope(definition.scope, binding);
  if (scope === null) return null;
  const namespace = deriveScheduleNamespace(binding.application, collection, scope);
  const origin = {
    ...binding,
    session: structuredClone(binding.session),
    channel: {
      kind: binding.channel.kind,
      continuationToken: binding.channel.continuationToken,
    },
  };
  const slack = captureSlackActionContext(origin.session.auth.current);
  const nextOperationId = binding.operationId ?? randomUUID;
  const providerContext = (): ScheduleProviderContext => {
    const target: {
      key: string;
      deliver?: (delivery: ScheduleDelivery<ScheduleCollectionPayload>) => Promise<void>;
    } = {
      key: binding.targetKey ?? collection,
    };
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
      await provider.create(providerContext(), {
        ...input,
        expression: validateScheduleExpression(input.expression),
        payload: createSchedulePayload({
          request: input.payload,
          binding: {
            application: binding.application,
            collection,
            namespace,
            name: validateScheduleName(input.name),
          },
          runAs: definition.runAs,
          context: origin,
          slack,
        }),
        name: validateScheduleName(input.name),
      }),
    delete: async (names) => {
      if (names.length < 1 || names.length > MAX_SCHEDULES_PER_DELETE) {
        throw new Error(`Delete between 1 and ${MAX_SCHEDULES_PER_DELETE} schedules per request.`);
      }
      const uniqueNames = [...new Set(names.map(validateScheduleName))];
      const results: ScheduleDeleteResult[] = [];
      for (const name of uniqueNames) {
        try {
          results.push({
            name,
            status: (await provider.delete(providerContext(), name)) ? "deleted" : "not-found",
          });
        } catch {
          results.push({ name, status: "failed" });
        }
      }
      return results;
    },
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
      // Providers cannot read the existing payload, so replacing it would lose the original caller.
      if (patch.payload !== undefined) {
        throw new Error(
          "Updating a scheduled request is not supported yet; delete and recreate the schedule.",
        );
      }
      const normalizedName = validateScheduleName(name);
      const expression =
        patch.expression === undefined ? undefined : validateScheduleExpression(patch.expression);
      if (expression !== undefined) {
        const current = await provider.get(providerContext(), normalizedName);
        if (current !== null && current.expression.type !== expression.type) {
          throw new Error("A schedule cannot change between recurring and one-time expressions.");
        }
      }
      let normalized: SchedulePatch<string> = {};
      if (expression !== undefined) normalized = { ...normalized, expression };
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
