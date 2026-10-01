import { loadContext } from "#context/container.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { readScheduleCollectionSource } from "#shared/schedule-collection-definition.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type {
  DefinedScheduleCollection,
  ScheduleClient,
  ScheduleScopeContext,
} from "#public/schedules/collection.js";
import { createScheduleCollectionClient } from "#runtime/schedules/collection-client.js";

/** Binds a registered collection to a scope checked by its per-operation policy. */
export async function schedules<TRequest, TMetadata>(
  collection: DefinedScheduleCollection<TRequest, TMetadata>,
): Promise<ScheduleClient<TRequest, TMetadata>> {
  const identity = readScheduleCollectionSource(collection);
  if (identity === undefined) {
    throw new Error("schedules(): collection must be a stamped agent/schedules module export.");
  }
  const definition = normalizeScheduleCollectionDefinition(
    collection,
    `Invalid schedule collection ${identity.logicalPath}.`,
  ) as DefinedScheduleCollection<TRequest, TMetadata>;
  const als = loadContext();
  const resolved = buildResolveContext(als, []);
  const scopeContext: ScheduleScopeContext = {
    abortSignal: new AbortController().signal,
    channel: {
      ...resolved.channel,
      currentTarget: (mode) => {
        const bundle = als.require(BundleKey);
        const active = bundle.graph.root.channels.find(
          (candidate) => resolved.channel.kind === `channel:${candidate.name}`,
        );
        if (active?.captureScheduleTarget === undefined)
          throw new Error(
            `Channel "${resolved.channel.kind ?? "current"}" does not support scheduled delivery.`,
          );
        return {
          ...active.captureScheduleTarget({
            mode,
            state: als.get(ChannelKey)?.state ?? {},
            ...(resolved.channel.continuationToken === undefined
              ? {}
              : { continuationToken: resolved.channel.continuationToken }),
          }),
          channel: active.name,
        };
      },
      mintPersonalTarget: async () => {
        const bundle = als.require(BundleKey);
        const active = bundle.graph.root.channels.find(
          (candidate) => resolved.channel.kind === `channel:${candidate.name}`,
        );
        if (active?.mintPersonalTarget === undefined)
          throw new Error(
            `Channel "${resolved.channel.kind ?? "current"}" does not support personal scheduled delivery.`,
          );
        const auth = resolved.session.auth.current;
        if (auth === null)
          throw new Error("Personal scheduled delivery requires an authenticated caller.");
        return { ...(await active.mintPersonalTarget(auth)), channel: active.name };
      },
    },
    session: resolved.session,
  };
  return createScheduleCollectionClient(definition, {
    ...scopeContext,
    session: resolved.session,
    application: identity.application,
    collection: identity.collection,
    channel: scopeContext.channel,
  });
}
