import type { ChannelAdapter } from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import { HTTP_ADAPTER } from "#channel/http.js";
import { SCHEDULE_ADAPTER } from "#channel/schedule.js";
import { SUBAGENT_ADAPTER } from "#execution/subagent-adapter.js";
import type { RuntimeRegistryEntryLocation } from "#internal/runtime-registry.js";
import { RuntimeRegistryError } from "#internal/runtime-registry.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

/**
 * Runtime-owned registry of adapter configs keyed by adapter kind.
 * Used to rebuild adapter instances (with behavior functions) after
 * workflow step boundaries.
 */
export interface RuntimeAdapterRegistry {
  readonly adaptersByKind: ReadonlyMap<string, ChannelAdapter>;
}

/**
 * Framework-provided adapter configs.
 *
 * Framework kinds cannot be shadowed with route-authored behavior.
 */
const FRAMEWORK_ADAPTERS: readonly ChannelAdapter[] = [
  HTTP_ADAPTER,
  SUBAGENT_ADAPTER,
  SCHEDULE_ADAPTER,
];

/**
 * Non-event-handler fields on a {@link ChannelAdapter}. Any other
 * key on the adapter object corresponds to a stream event handler
 * keyed by event type (see {@link ChannelEventHandlers}). Used by
 * {@link carriesAdapterBehavior} to detect whether a route-declared
 * adapter contributes behavior beyond the bare `kind`.
 */
const ADAPTER_NON_EVENT_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "state",
  "deliver",
  "createAdapterContext",
  "fetchFile",
  "instrumentation",
]);

/**
 * Builds the runtime-owned adapter registry from framework adapters plus any
 * custom adapters declared on resolved route definitions.
 *
 * Route-declared adapters may share framework kinds only as pass-throughs.
 */
export function createRuntimeAdapterRegistry(input: {
  readonly channels: readonly ResolvedChannelDefinition[];
}): RuntimeAdapterRegistry {
  const adaptersByKind = new Map<string, ChannelAdapter>();
  const frameworkKinds = new Set<string>();

  // Pass 1: register framework adapters. Each owns its kind
  // permanently — route-declared adapters can share the kind only
  // if they carry no authored behavior (strictly additive
  // pass-through).
  for (const adapter of FRAMEWORK_ADAPTERS) {
    const kind = requireAdapterKind(adapter);
    frameworkKinds.add(kind);
    adaptersByKind.set(kind, adapter);
  }

  // Pass 2: register route-declared adapters. Validates that
  // authored adapters do not shadow a framework kind with
  // behavior.
  for (const channelDefinition of input.channels) {
    if (channelDefinition.adapter === undefined) {
      continue;
    }

    const location: RuntimeRegistryEntryLocation = {
      logicalPath: channelDefinition.logicalPath,
      sourceId: channelDefinition.sourceId,
    };
    const adapter = channelDefinition.adapter;
    const kind = requireAdapterKind(adapter, location);

    if (frameworkKinds.has(kind)) {
      if (carriesAdapterBehavior(adapter)) {
        throw new RuntimeRegistryError(
          "adapter",
          `Channel adapter kind "${kind}" is reserved by the framework. ` +
            `A route-declared adapter may share a framework kind only as a ` +
            `pass-through with no \`deliver\` hook, event handlers, ` +
            `\`attachments\` resolver, or \`createAdapterContext\` factory. ` +
            `Use a custom \`kind\` to add channel-specific behavior.`,
          { ...location, entryName: kind },
        );
      }
      // Additive pass-through — the framework adapter stays in place.
      continue;
    }

    // Non-framework kind. The last route-declared adapter for this
    // kind wins, matching the pre-Phase-4 behavior for authored
    // kinds.
    adaptersByKind.set(kind, adapter);
  }

  return { adaptersByKind };
}

/**
 * Rehydrates one serialized adapter from the runtime-owned registry.
 *
 * Looks up the adapter config by `kind`, then merges the serialized state
 * onto it. The result is a full adapter with behavior functions and
 * restored state.
 */
export function deserializeRuntimeAdapter(
  registry: RuntimeAdapterRegistry,
  data: unknown,
): ChannelAdapter {
  const serialized = data as {
    kind: string;
    state: Record<string, unknown>;
  };

  const adapterConfig = registry.adaptersByKind.get(serialized.kind);

  if (adapterConfig === undefined) {
    throw new Error(
      `Unknown adapter kind: "${serialized.kind}". Declare the adapter on the route that starts this session so the runtime can rehydrate it.`,
    );
  }

  // Merge the serialized state onto the adapter config. The behavior
  // functions come from the registry entry; the state comes from the
  // serialized context.
  return { ...adapterConfig, state: serialized.state };
}

function requireAdapterKind(
  adapter: ChannelAdapter,
  location?: RuntimeRegistryEntryLocation,
): string {
  const kind = getAdapterKind(adapter);

  if (typeof kind !== "string" || kind.length === 0) {
    throw new RuntimeRegistryError("adapter", "Adapters must declare a non-empty `kind` field.", {
      entryName: "unknown",
      logicalPath: location?.logicalPath,
      sourceId: location?.sourceId,
    });
  }

  return kind;
}

/**
 * Returns true if the adapter contributes any authored behavior beyond
 * the bare `kind` discriminator (and initial `state`).
 */
function carriesAdapterBehavior(adapter: ChannelAdapter): boolean {
  if (adapter.deliver !== undefined) {
    return true;
  }

  if (adapter.fetchFile !== undefined) {
    return true;
  }

  if (adapter.createAdapterContext !== undefined) {
    return true;
  }

  // Remaining keys on a ChannelAdapter object correspond to stream
  // event handlers (keyed by event type, e.g. "input.requested").
  for (const [key, value] of Object.entries(adapter)) {
    if (ADAPTER_NON_EVENT_FIELDS.has(key)) {
      continue;
    }
    if (typeof value === "function") {
      return true;
    }
  }

  return false;
}
