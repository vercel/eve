import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { createHash, randomUUID } from "node:crypto";
import { loadContext } from "#context/container.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type {
  ScheduleClient,
  ScheduleClientCreate,
  ScheduleSubscriptionDefinition,
  ScheduleEnvelope,
  SchedulePageResult,
  SchedulePrincipalReference,
  ScheduleScopeContext,
  ScheduleScopeValue,
} from "#public/schedules/subscription.js";
import { projectScheduleRecord } from "#runtime/schedules/record.js";
import { byPrincipal } from "#public/schedules/scope.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import {
  createScheduleCollectionPayload,
  validateSchedulePayload,
  type ScheduleCollectionPayload,
} from "#runtime/schedules/payload.js";
import {
  resolveScheduleTiming,
  validateScheduleListLimit,
  validateScheduleName,
} from "#runtime/schedules/validation.js";

export interface ScheduleBoundCallContext extends ScheduleScopeContext {
  readonly application: string;
  readonly collection: string;
  readonly operationId?: () => string;
}

export function createScheduleCollectionClient<TPayload, TPrepared = TPayload>(
  definition: ScheduleSubscriptionDefinition<
    TPayload,
    StandardSchemaV1<unknown, TPayload>,
    TPrepared
  >,
  callContext: ScheduleBoundCallContext,
): ScheduleClient<TPayload> {
  const nextOperationId = callContext.operationId ?? randomUUID;

  const contextFor = (
    operation: NonNullable<ScheduleScopeContext["operation"]>,
    name?: string,
  ): ScheduleScopeContext & {
    readonly operation: NonNullable<ScheduleScopeContext["operation"]>;
  } => {
    const context = { ...callContext, operation } as ScheduleScopeContext & {
      operation: NonNullable<ScheduleScopeContext["operation"]>;
      name?: string;
    };
    if (name !== undefined) context.name = name;
    return context;
  };
  const resolveNamespace = async (
    operation: NonNullable<ScheduleScopeContext["operation"]>,
    name?: string,
  ): Promise<{ scope: ScheduleScopeValue; provider: ScheduleProviderContext }> => {
    assertScheduleManagementAllowed(callContext.session.auth.current);
    const context = contextFor(operation, name);
    const scope =
      definition.scope === undefined
        ? byPrincipal(context)
        : await definition.scope({ ...context, operation });
    if (scope === null) throw new Error(`Schedule ${operation} is not available in this context.`);
    validateScope(scope);
    const provider: ScheduleProviderContext = {
      abortSignal: callContext.abortSignal,
      collection: callContext.collection,
      namespace: deriveScheduleNamespace(callContext.application, callContext.collection, scope),
      operationId: nextOperationId(),
      target: {
        key: callContext.application,
        deliver: async ({ payload, occurrence }) => {
          await dispatchScheduledOccurrence({
            bundle: loadContext().require(BundleKey),
            collection: callContext.collection,
            definition,
            occurrence: { ...occurrence, collection: callContext.collection },
            payload: payload as ScheduleCollectionPayload<unknown>,
          });
        },
      },
    };
    return { scope, provider };
  };

  return {
    async create(input: ScheduleClientCreate<TPayload>) {
      const displayName = validateScheduleName(input.name);
      const name = `${displayName.slice(0, 219)}--${randomUUID()}`;
      const expression = resolveScheduleTiming(input.expression);
      const { scope, provider } = await resolveNamespace("create", displayName);
      const creator = principalReference(callContext.session.auth.current);
      if (creator === null)
        throw new Error("Creating a schedule requires an authenticated principal.");
      const validated = await validateSchedulePayload<TPayload>(definition.schema, input.payload);
      const prepared =
        definition.prepare === undefined
          ? validated
          : await definition.prepare(validated, {
              ...contextFor("create", displayName),
              operation: "create",
              name: displayName,
            });
      const envelope: ScheduleEnvelope<TPayload | TPrepared> = {
        version: 3,
        payload: prepared,
        scope,
        principal: creator,
      };
      const payload = createScheduleCollectionPayload({
        application: callContext.application,
        collection: callContext.collection,
        envelope,
      });
      return projectScheduleRecord(
        await definition.provider.create(provider, { expression, name, payload }),
      );
    },
    async delete(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("delete", normalized);
      return await definition.provider.delete(provider, normalized);
    },
    async disable(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("disable", normalized);
      return projectScheduleRecord(await definition.provider.disable(provider, normalized));
    },
    async enable(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("enable", normalized);
      return projectScheduleRecord(await definition.provider.enable(provider, normalized));
    },
    async get(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("get", normalized);
      const record = await definition.provider.get(provider, normalized);
      return record === null ? null : projectScheduleRecord(record);
    },
    async invoke(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("invoke", normalized);
      await definition.provider.invoke(provider, normalized);
    },
    async list(input = {}): Promise<SchedulePageResult> {
      const limit = validateScheduleListLimit(input.limit);
      const { provider } = await resolveNamespace("list");
      const query: { cursor?: string; limit?: number } = {};
      if (input.cursor?.trim()) query.cursor = input.cursor.trim();
      if (limit !== undefined) query.limit = limit;
      const page = await definition.provider.list(provider, query);
      return { ...page, data: page.data.map(projectScheduleRecord) };
    },
  };
}

export function assertScheduleManagementAllowed(
  auth: { readonly attributes: Readonly<Record<string, string | readonly string[]>> } | null,
): void {
  const value = auth?.attributes["eve.scheduled_run"];
  if (value === "true" || (Array.isArray(value) && value.includes("true")))
    throw new Error("Schedule management is unavailable during scheduled execution.");
}

function principalReference(
  auth: {
    readonly principalType: string;
    readonly authenticator: string;
    readonly issuer?: string;
    readonly principalId: string;
    readonly subject?: string;
  } | null,
): SchedulePrincipalReference | null {
  if (auth === null || auth.principalType === "anonymous" || auth.principalType === "runtime")
    return null;
  const reference: {
    type: string;
    authenticator: string;
    issuer?: string;
    principalId: string;
    subject?: string;
  } = {
    type: auth.principalType,
    authenticator: auth.authenticator,
    principalId: auth.principalId,
  };
  if (auth.issuer !== undefined) reference.issuer = auth.issuer;
  if (auth.subject !== undefined) reference.subject = auth.subject;
  return reference;
}

function validateScope(scope: ScheduleScopeValue): void {
  const values = typeof scope === "string" ? [scope] : scope;
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || value.trim().length === 0)
  )
    throw new Error("Schedule scope must be a non-empty string or tuple of non-empty strings.");
}

function deriveScheduleNamespace(
  application: string,
  collection: string,
  scope: ScheduleScopeValue,
): string {
  if (application.trim().length === 0) throw new Error("Schedule application must not be empty.");
  const digest = createHash("sha256")
    .update(JSON.stringify(["eve-schedule-namespace-v2", application, collection, scope]))
    .digest("base64url");
  return `eve-${digest}`;
}
