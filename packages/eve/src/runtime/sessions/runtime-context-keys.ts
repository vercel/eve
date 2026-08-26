/**
 * Runtime-tier context keys whose codecs call back into the runtime to
 * materialize their values. Leaf keys (no codec) live in `#context/keys.ts`.
 */

import type { ChannelAdapter } from "#channel/adapter.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { getAdapterKind } from "#channel/adapter.js";
import { ContextKey } from "#context/key.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { deserializeRuntimeAdapter } from "#runtime/channels/registry.js";
import {
  type DurableCompiledArtifactsSource,
  resolveDurableCompiledArtifactsSource,
  serializeDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import {
  type CompiledRuntimeAgentBundle,
  getCompiledRuntimeAgentBundle,
} from "#runtime/sessions/compiled-agent-cache.js";

/** Wire format for a serialized channel adapter. */
interface SerializedAdapter {
  readonly kind: string;
  readonly state: Record<string, unknown>;
  readonly audience?: ChannelAudience;
}

/** Compiled bundle on the durable context — re-exported under a stable name. */
export type CompiledBundle = CompiledRuntimeAgentBundle;

interface SerializedBundle {
  readonly nodeId?: string;
  readonly source: DurableCompiledArtifactsSource;
}

export const ChannelKey = new ContextKey<ChannelAdapter>(CHANNEL_CONTEXT_KEY_NAME, {
  codec: {
    serialize(adapter): SerializedAdapter {
      const projection = buildChannelInstrumentationProjection({ adapter });
      return {
        kind: getAdapterKind(adapter),
        state: adapter.state ? { ...adapter.state } : {},
        audience: projection.metadata.audience,
      };
    },
    deserialize(data, ctx): ChannelAdapter {
      const bundle = ctx.get(BundleKey);

      if (bundle === undefined) {
        throw new Error(
          'Cannot deserialize "eve.channel" before "eve.bundle". The runtime bundle must be present in context.',
        );
      }

      return deserializeRuntimeAdapter(bundle.adapterRegistry, data);
    },
  },
});

export const BundleKey = new ContextKey<CompiledBundle>("eve.bundle", {
  codec: {
    serialize: (bundle): SerializedBundle => ({
      nodeId: bundle.nodeId,
      source: serializeDurableCompiledArtifactsSource(bundle.compiledArtifactsSource),
    }),
    deserialize: (data) => {
      const { source, nodeId } = data as SerializedBundle;
      return getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: resolveDurableCompiledArtifactsSource(source),
        nodeId,
      });
    },
  },
});
