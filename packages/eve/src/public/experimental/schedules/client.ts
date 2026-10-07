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
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getAdapterKind } from "#channel/adapter.js";
import type {
  DefinedScheduleSubscription,
  ScheduleClient,
} from "#public/schedules/subscription.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import {
  createScheduleCollectionClient,
  type ScheduleCollectionClient,
} from "#runtime/schedules/collection-client.js";

/** Binds a registered subscription to a scope authorized on every operation. */
export async function schedules<TPayload, TPrepared = TPayload>(
  collection: DefinedScheduleSubscription<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>,
): Promise<ScheduleClient<TPayload>> {
  return await bindScheduleCollection(collection);
}

/** Shared binding for model approval preview and code-only client access. */
export async function bindScheduleCollection<TPayload, TPrepared = TPayload>(
  collection: DefinedScheduleSubscription<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>,
): Promise<ScheduleCollectionClient<TPayload, TPrepared>> {
  const identity = readScheduleCollectionSource(collection);
  if (identity === undefined)
    throw new Error("schedules(): subscription must be a stamped agent/schedules module export.");
  const definition = normalizeScheduleCollectionDefinition(
    collection,
    `Invalid schedule subscription ${identity.logicalPath}.`,
  ) as DefinedScheduleSubscription<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>;
  const context = loadContext();
  const channel = context.get(ChannelKey);
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
      kind: channel === undefined ? undefined : getAdapterKind(channel),
      continuationToken: context.get(ContinuationTokenKey),
      metadata: context.get(ChannelInstrumentationKey)?.metadata,
    },
    application: identity.application,
    collection: identity.collection,
  });
}
