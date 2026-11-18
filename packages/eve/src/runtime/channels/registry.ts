import type { ChannelAdapter } from "#channel/adapter.js";
import { getAdapterKind, seedChannelState } from "#channel/adapter.js";
import { HTTP_ADAPTER } from "#channel/http.js";
import { SCHEDULE_ADAPTER } from "#channel/schedule.js";
import { SUBAGENT_ADAPTER } from "#subagents/adapter.js";
import type { RuntimeRegistryEntryLocation } from "#internal/runtime-registry.js";
import { RuntimeRegistryError } from "#internal/runtime-registry.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

export interface RuntimeAdapterRegistry {
  readonly adaptersByKind: ReadonlyMap<string, ChannelAdapter>;
}

const FRAMEWORK_ADAPTERS: readonly ChannelAdapter[] = [
  HTTP_ADAPTER,
  SUBAGENT_ADAPTER,
  SCHEDULE_ADAPTER,
];

const ADAPTER_NON_EVENT_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "state",
  "deliver",
  "createAdapterContext",
  "fetchFile",
  "instrumentation",
  "uploadPolicy",
]);

export function createRuntimeAdapterRegistry(input: {
  readonly channels: readonly ResolvedChannelDefinition[];
}): RuntimeAdapterRegistry {
  const adaptersByKind = new Map<string, ChannelAdapter>();
  const frameworkKinds = new Set<string>();

  for (const adapter of FRAMEWORK_ADAPTERS) {
    const kind = requireAdapterKind(adapter);
    frameworkKinds.add(kind);
    adaptersByKind.set(kind, adapter);
  }

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
      continue;
    }

    adaptersByKind.set(kind, adapter);
  }

  return { adaptersByKind };
}

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

  return { ...adapterConfig, state: seedChannelState(adapterConfig.state, serialized.state) };
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

function carriesAdapterBehavior(adapter: ChannelAdapter): boolean {
  if (adapter.deliver !== undefined) {
    return true;
  }

  if (adapter.fetchFile !== undefined) {
    return true;
  }

  if (adapter.uploadPolicy !== undefined) {
    return true;
  }

  if (adapter.createAdapterContext !== undefined) {
    return true;
  }

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
