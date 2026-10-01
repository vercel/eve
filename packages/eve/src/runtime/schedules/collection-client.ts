import { createHash, randomUUID } from "node:crypto";
import { loadContext } from "#context/container.js";
import { admitScheduledOccurrence } from "#runtime/schedules/admit-occurrence.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type {
  ScheduleClient,
  ScheduleClientCreate,
  ScheduleCollectionDefinition,
  ScheduleDeliveryBinding,
  ScheduleEnvelope,
  SchedulePageResult,
  SchedulePrincipalReference,
  ScheduleScopeContext,
  ScheduleScopeValue,
} from "#public/schedules/collection.js";
import type {
  ScheduleCaptureContext,
  ScheduleDeliveryDefinition,
} from "#public/schedules/delivery.js";
import { byPrincipal } from "#public/schedules/scope.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import {
  createScheduleCollectionPayload,
  type ScheduleCollectionPayload,
} from "#runtime/schedules/payload.js";
import {
  resolveScheduleDeliveryNames,
  resolveScheduleTiming,
  validateScheduleListLimit,
  validateScheduleName,
} from "#runtime/schedules/validation.js";
import { z } from "#compiled/zod/index.js";
import type { JsonValue } from "#shared/json.js";

export interface ScheduleBoundCallContext extends ScheduleScopeContext {
  readonly application: string;
  readonly collection: string;
  readonly operationId?: () => string;
}

const defaultRequestSchema = z.string().min(1).max(2000);
const defaultMetadataSchema = z.object({}).strict();

export function createScheduleCollectionClient<TRequest, TMetadata>(
  definition: ScheduleCollectionDefinition<TRequest, TMetadata>,
  callContext: ScheduleBoundCallContext,
): ScheduleClient<TRequest, TMetadata> {
  const nextOperationId = callContext.operationId ?? randomUUID;
  const requestSchema = definition.request ?? defaultRequestSchema;
  const metadataSchema = definition.metadata ?? defaultMetadataSchema;

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
          await admitScheduledOccurrence({
            bundle: loadContext().require(BundleKey),
            collection: callContext.collection,
            definition,
            namespace: deriveScheduleNamespace(
              callContext.application,
              callContext.collection,
              scope,
            ),
            occurrence: { ...occurrence, collection: callContext.collection },
            payload: payload as ScheduleCollectionPayload<unknown, unknown>,
          });
        },
      },
    };
    return { scope, provider };
  };

  return {
    async create(input: ScheduleClientCreate<TRequest, TMetadata>) {
      const name = validateScheduleName(input.name);
      const deliveryNames = resolveScheduleDeliveryNames(input.deliveries, definition.deliveries);
      const expression = resolveScheduleTiming(input.expression);
      const request = await parseSchema<TRequest>(requestSchema, input.request, "request");
      // The request is run as prompt text, so it must be a non-empty string. Length limits
      // belong to the request schema; the default allows 2,000 characters.
      if (typeof request !== "string" || request.trim().length === 0)
        throw new Error("Invalid schedule request: expected a non-empty string.");
      const metadata = await parseSchema<TMetadata>(
        metadataSchema,
        input.metadata ?? {},
        "metadata",
      );
      const { scope, provider } = await resolveNamespace("create", name);
      const creator = principalReference(callContext.session.auth.current);
      if (creator === null)
        throw new Error("Creating a schedule requires an authenticated principal.");
      // Sequential and all-or-nothing: nothing is stored unless every capture succeeds.
      const captureContext = { ...contextFor("create", name), request, metadata };
      const deliveries: Record<string, ScheduleDeliveryBinding> = {};
      for (const deliveryName of deliveryNames) {
        deliveries[deliveryName] = await captureDelivery(
          deliveryName,
          definition.deliveries[deliveryName]!,
          captureContext,
        );
      }
      const envelope: ScheduleEnvelope<TRequest, TMetadata> = {
        version: 2,
        request,
        scope,
        principal: creator,
        metadata,
        deliveries,
      };
      const payload = createScheduleCollectionPayload({
        application: callContext.application,
        collection: callContext.collection,
        envelope,
      });
      const record = await definition.provider.create(provider, { expression, name, payload });
      return {
        ...record,
        deliveries: deliveryNames.map((deliveryName) => {
          const label = deliveries[deliveryName]!.label;
          return label === undefined ? { name: deliveryName } : { name: deliveryName, label };
        }),
      };
    },
    async delete(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("delete", normalized);
      return await definition.provider.delete(provider, normalized);
    },
    async disable(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("disable", normalized);
      return await definition.provider.disable(provider, normalized);
    },
    async enable(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("enable", normalized);
      return await definition.provider.enable(provider, normalized);
    },
    async get(name) {
      const normalized = validateScheduleName(name);
      const { provider } = await resolveNamespace("get", normalized);
      return await definition.provider.get(provider, normalized);
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
      return await definition.provider.list(provider, query);
    },
    async update(name, patch) {
      const unsupported = Object.keys(patch).filter((key) => key !== "expression");
      if (unsupported.length > 0)
        throw new Error(
          `Schedule update only supports timing changes; unsupported fields: ${unsupported.join(", ")}.`,
        );
      const normalized = validateScheduleName(name);
      const expression =
        patch.expression === undefined ? undefined : resolveScheduleTiming(patch.expression);
      const { provider } = await resolveNamespace("update", normalized);
      if (expression !== undefined) {
        const current = await definition.provider.get(provider, normalized);
        if (current !== null && current.expression.type !== expression.type)
          throw new Error("A schedule cannot change between recurring and one-time expressions.");
      }
      return await definition.provider.update(
        provider,
        normalized,
        expression === undefined ? {} : { expression },
      );
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

async function parseSchema<T>(
  schema: { readonly "~standard": { validate(value: unknown): unknown } },
  value: unknown,
  label: string,
): Promise<T> {
  const result = (await schema["~standard"].validate(value)) as {
    readonly issues?: readonly { readonly message: string }[];
    readonly value?: T;
  };
  if (result.issues !== undefined || !("value" in result))
    throw new Error(
      `Invalid schedule ${label}: ${result.issues?.map((issue) => issue.message).join("; ") ?? "schema validation failed"}.`,
    );
  return result.value as T;
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

async function captureDelivery(
  name: string,
  delivery: ScheduleDeliveryDefinition<any>,
  context: ScheduleCaptureContext,
): Promise<ScheduleDeliveryBinding> {
  if (delivery.capture === undefined) return {};
  let captured;
  try {
    captured = await delivery.capture(context);
  } catch (error) {
    throw new Error(
      `Delivery "${name}" cannot be used: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const stored: { label?: string; binding?: JsonValue } = {};
  const label = captured.label?.trim();
  if (label !== undefined && label !== "") stored.label = label.slice(0, 256);
  if (captured.binding !== undefined) stored.binding = captured.binding;
  return stored;
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
