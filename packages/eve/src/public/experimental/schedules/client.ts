import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { loadContext } from "#context/container.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { readScheduleCollectionSource } from "#shared/schedule-collection-definition.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SessionIdKey,
  ContinuationTokenKey,
  ChannelInstrumentationKey,
} from "#context/keys.js";
import type { DefinedDynamicSchedules, ScheduleClient } from "#public/schedules/subscription.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import { namedScopeDefinition } from "#runtime/schedules/named-scope.js";
import {
  createScheduleCollectionClient,
  type ScheduleCollectionClient,
} from "#runtime/schedules/collection-client.js";

/**
 * Binds a dynamic schedules definition to a client whose scope is authorized on every operation.
 * A definition with named `scopes` takes the one to act in as `options.scope`.
 */
export async function schedules<TPayload, TPrepared = TPayload>(
  collection: DefinedDynamicSchedules<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>,
  options: { readonly scope?: string } = {},
): Promise<ScheduleClient<TPayload>> {
  if (collection.scopes === undefined) {
    if (options.scope !== undefined)
      throw new Error(
        `schedules(): this definition declares no "scopes", so it takes no scope "${options.scope}".`,
      );
    return await bindScheduleCollection(collection);
  }
  if (options.scope === undefined)
    throw new Error(
      `schedules(): this definition declares scopes; pass one as { scope }: ${Object.keys(collection.scopes).join(", ")}.`,
    );
  return await bindScheduleCollection(
    namedScopeDefinition(collection, options.scope) as typeof collection,
  );
}

/** Shared binding for model approval preview and code-only client access. */
export async function bindScheduleCollection<TPayload, TPrepared = TPayload>(
  collection: DefinedDynamicSchedules<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>,
): Promise<ScheduleCollectionClient<TPayload, TPrepared>> {
  const identity = readScheduleCollectionSource(collection);
  if (identity === undefined)
    throw new Error(
      "schedules(): argument must be a defineDynamicSchedules() definition exported from a module in agent/schedules/.",
    );
  const definition = normalizeScheduleCollectionDefinition(
    collection,
    `Invalid dynamic schedules definition ${identity.logicalPath}.`,
  ) as DefinedDynamicSchedules<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>;
  const context = loadContext();
  return createScheduleCollectionClient(definition, {
    abortSignal: new AbortController().signal,
    session: {
      id: context.get(SessionIdKey) ?? "",
      schedule: readSessionSchedule(context),
      auth: {
        current: context.get(AuthKey) ?? null,
        initiator: context.get(InitiatorAuthKey) ?? null,
      },
    },
    channel: {
      kind: normalizeInstrumentationChannelKind(context.get(ChannelInstrumentationKey)?.kind),
      continuationToken: context.get(ContinuationTokenKey),
      metadata: context.get(ChannelInstrumentationKey)?.metadata ?? {},
    },
    application: identity.application,
    collection: identity.collection,
  });
}
