import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { contextStorage, loadContext } from "#context/container.js";
import type { AuthResult } from "#channel/auth/definitions.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { readScheduleCollectionSource } from "#shared/schedule-collection-definition.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SessionIdKey,
  ContinuationTokenKey,
  ChannelInstrumentationKey,
  SteeredByKey,
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
 *
 * Inside a turn the client acts as the turn's caller. Outside a turn, such as in an HTTP channel
 * route handler, pass the caller's verified principal as `options.auth`, for example the result
 * of `routeAuth`; the client then acts as that principal and the definition's `scope` resolves
 * from it. Passing `auth` inside a turn throws, because a turn's principal never changes.
 * Out of a turn, `invoke` is not available, because there is no agent to run the occurrence.
 */
export async function schedules<TPayload, TPrepared = TPayload>(
  collection: DefinedDynamicSchedules<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>,
  options: { readonly scope?: string; readonly auth?: AuthResult } = {},
): Promise<ScheduleClient<TPayload>> {
  if (collection.scopes === undefined) {
    if (options.scope !== undefined)
      throw new Error(
        `schedules(): this definition declares no "scopes", so it takes no scope "${options.scope}".`,
      );
    return await bindScheduleCollection(collection, options.auth);
  }
  if (options.scope === undefined)
    throw new Error(
      `schedules(): this definition declares scopes; pass one as { scope }: ${Object.keys(collection.scopes).join(", ")}.`,
    );
  return await bindScheduleCollection(
    namedScopeDefinition(collection, options.scope) as typeof collection,
    options.auth,
  );
}

export async function bindScheduleCollection<TPayload, TPrepared = TPayload>(
  collection: DefinedDynamicSchedules<TPayload, StandardSchemaV1<unknown, TPayload>, TPrepared>,
  auth?: AuthResult,
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
  const bound = { application: identity.application, collection: identity.collection };
  if (auth !== undefined) {
    const active = contextStorage.getStore();
    if (active?.get(SessionIdKey) !== undefined || active?.get(AuthKey) !== undefined)
      throw new Error(
        "schedules(): a turn's principal cannot be overridden; omit `auth` inside a turn.",
      );
    const client = createScheduleCollectionClient(definition, {
      abortSignal: new AbortController().signal,
      session: { id: "", auth: { current: auth, initiator: auth } },
      channel: { kind: "http", metadata: {} },
      ...bound,
    });
    return {
      ...client,
      async invoke() {
        throw new Error("schedules(): invoke is only available inside a turn.");
      },
    };
  }
  const context = loadContext();
  const steeredBy = context.get(SteeredByKey);
  return createScheduleCollectionClient(definition, {
    abortSignal: new AbortController().signal,
    session: {
      id: context.get(SessionIdKey) ?? "",
      schedule: readSessionSchedule(context),
      auth: {
        current: context.get(AuthKey) ?? null,
        initiator: context.get(InitiatorAuthKey) ?? null,
        ...(steeredBy !== undefined && steeredBy.length > 0 && { steeredBy }),
      },
    },
    channel: {
      kind: normalizeInstrumentationChannelKind(context.get(ChannelInstrumentationKey)?.kind),
      continuationToken: context.get(ContinuationTokenKey),
      metadata: context.get(ChannelInstrumentationKey)?.metadata ?? {},
    },
    ...bound,
  });
}
