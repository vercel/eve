/**
 * Runtime-tier context keys whose codecs call back into the runtime to
 * materialize their values. Leaf keys (no codec) live in `#context/keys.ts`.
 */

import type { ChannelAdapter } from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import type { ContextReader } from "#context/key.js";
import { ContextKey } from "#context/key.js";
import { BUNDLE_CONTEXT_KEY_NAME, CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { deserializeRuntimeAdapter } from "#runtime/channels/registry.js";
import {
  type DurableCompiledArtifactsSource,
  resolveDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { loadCompiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import type { SessionAgent, SessionAgentReference } from "#runtime/sessions/session-agent.js";

/** Wire format for a serialized channel adapter. */
interface SerializedAdapter {
  readonly kind: string;
  readonly state: Record<string, unknown>;
}

/** A compiled agent's node, as `SessionAgent.compiled` holds it. */
export type CompiledBundle = CompiledRuntimeAgentBundle;

/** How a session stores its agent's reference: `eve.bundle`, as compiled sessions always have. */
interface SerializedAgentReference {
  readonly nodeId?: string;
  readonly source: DurableCompiledArtifactsSource;
}

export const ChannelKey = new ContextKey<ChannelAdapter>(CHANNEL_CONTEXT_KEY_NAME, {
  codec: {
    serialize(adapter): SerializedAdapter {
      return {
        kind: getAdapterKind(adapter),
        state: adapter.state ? { ...adapter.state } : {},
      };
    },
    deserialize(data, ctx): ChannelAdapter {
      const agent = ctx.get(SessionAgentKey);
      if (agent === undefined) {
        throw new Error(
          'Cannot deserialize "eve.channel" before the session\'s agent: it must be present in context.',
        );
      }
      return deserializeRuntimeAdapter(agent.adapters, data);
    },
  },
});

/**
 * The session's agent. A step boundary carries its `reference`, which the codec writes and reads
 * back as the agent: `#context/serialize.js` reads it first, since the channel rehydrates from it.
 */
export const SessionAgentKey = new ContextKey<SessionAgent>(BUNDLE_CONTEXT_KEY_NAME, {
  codec: {
    serialize: (agent): SerializedAgentReference => writeAgentReference(agent.reference),
    deserialize: async (data) => await resolveSessionAgent(readAgentReference(data)),
  },
});

/** The compiled node of the session's agent, when the agent was compiled from files. */
export function compiledBundleOf(ctx: Pick<ContextReader, "get">): CompiledBundle | undefined {
  return ctx.get(SessionAgentKey)?.compiled;
}

/** The compiled node of the session's agent, for features only files declare. */
export function requireCompiledBundle(ctx: Pick<ContextReader, "get">): CompiledBundle {
  const bundle = compiledBundleOf(ctx);
  if (bundle === undefined) {
    throw new Error(
      "This needs an agent compiled from files: the session's context has no compiled agent.",
    );
  }
  return bundle;
}

/** The agent `reference` names, loaded in this process. */
export async function resolveSessionAgent(reference: SessionAgentReference): Promise<SessionAgent> {
  return await loadCompiledSessionAgent({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(reference.source),
    nodeId: reference.nodeId,
  });
}

function writeAgentReference(reference: SessionAgentReference): SerializedAgentReference {
  return { nodeId: reference.nodeId, source: reference.source };
}

function readAgentReference(data: unknown): SessionAgentReference {
  const { nodeId, source } = data as SerializedAgentReference;
  return { kind: "bundle", nodeId, source };
}
