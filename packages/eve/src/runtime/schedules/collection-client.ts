import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readSessionSchedule } from "#context/session-schedule.js";
import { loadContext, contextStorage } from "#context/container.js";
import type { SessionSchedule } from "#context/session-schedule.js";
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

export interface PreparedScheduleCreate<TPrepared = unknown> {
  readonly displayName: string;
  readonly expression: import("#public/schedules/subscription.js").ScheduleTiming;
  readonly envelope: ScheduleEnvelope<TPrepared>;
}

/** Internal capabilities used by generated create approval; authored clients expose only create. */
export interface ScheduleCollectionClient<TInput, TPrepared> extends ScheduleClient<TInput> {
  prepareCreate(
    input: ScheduleClientCreate<TInput>,
  ): Promise<PreparedScheduleCreate<TInput | TPrepared>>;
  create(
    input: ScheduleClientCreate<TInput>,
    approved?: PreparedScheduleCreate,
  ): Promise<import("#public/schedules/subscription.js").ScheduleRecord>;
}

export function createScheduleCollectionClient<TPayload, TPrepared = TPayload>(
  definition: ScheduleSubscriptionDefinition<
    TPayload,
    StandardSchemaV1<unknown, TPayload>,
    TPrepared
  >,
  callContext: ScheduleBoundCallContext,
): ScheduleCollectionClient<TPayload, TPrepared> {
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
    assertScheduleManagementAllowed(callContext.session.schedule);
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

  const prepareCreation = async (input: ScheduleClientCreate<TPayload>) => {
    const displayName = validateScheduleName(input.name);
    // Validate timing before preparation; relative delays are resolved again at the write boundary.
    resolveScheduleTiming(input.expression);
    const { scope, provider } = await resolveNamespace("create", displayName);
    const creator = principalReference(callContext.session.auth.current);
    if (creator === null)
      throw new Error("Creating a schedule requires an authenticated principal.");
    const validated = await validateSchedulePayload<TPayload>(definition.schema, input.payload);
    const preparedPayload =
      definition.prepare === undefined
        ? validated
        : await definition.prepare(validated, {
            ...contextFor("create", displayName),
            operation: "create",
            name: displayName,
          });
    const envelope: ScheduleEnvelope<TPayload | TPrepared> = {
      version: 3,
      payload: preparedPayload,
      scope,
      principal: creator,
    };
    const payload = createScheduleCollectionPayload({
      application: callContext.application,
      collection: callContext.collection,
      envelope,
    });
    const prepared = {
      displayName,
      expression: JSON.parse(
        JSON.stringify(input.expression),
      ) as import("#public/schedules/subscription.js").ScheduleTiming,
      envelope: payload.envelope,
    };
    if (Buffer.byteLength(JSON.stringify(prepared)) > 64 * 1024)
      throw new Error(
        "Prepared schedule creation exceeds the 64 KB limit, including timing and payload.",
      );
    return { prepared, provider };
  };

  return {
    async prepareCreate(input) {
      return (await prepareCreation(input)).prepared;
    },
    async create(input, approved) {
      const { prepared, provider } = await prepareCreation(input);
      if (approved !== undefined && !isDeepStrictEqual(prepared, approved))
        throw new Error(
          "Schedule creation changed after approval. Request a new creation approval; no schedule was written.",
        );
      const name = `${prepared.displayName.slice(0, 218)}--${randomUUID()}`;
      const expression = resolveScheduleTiming(input.expression);
      const payload = createScheduleCollectionPayload({
        application: callContext.application,
        collection: callContext.collection,
        envelope: prepared.envelope,
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

export function assertScheduleManagementAllowed(schedule?: SessionSchedule): void {
  const context = contextStorage.getStore();
  if (
    schedule !== undefined ||
    (context !== undefined && readSessionSchedule(context) !== undefined)
  )
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
