/**
 * Runtime-tier context keys whose codecs call back into the runtime to
 * materialize their values. Leaf keys (no codec) live in `#context/keys.ts`.
 */

import type { ChannelAdapter } from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import type { ContextReader } from "#context/key.js";
import { ContextKey } from "#context/key.js";
import {
  BUNDLE_CONTEXT_KEY_NAME,
  CHANNEL_CONTEXT_KEY_NAME,
  SESSION_AGENT_CONTEXT_KEY_NAME,
} from "#context/key-names.js";
import { deserializeRuntimeAdapter } from "#runtime/channels/registry.js";
import {
  type DurableCompiledArtifactsSource,
  resolveDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { loadCompiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import {
  type BundleReference,
  resolveHeldSessionAgent,
  type SessionAgent,
  type SessionAgentReference,
} from "#runtime/sessions/session-agent.js";

/** Wire format for a serialized channel adapter. */
interface SerializedAdapter {
  readonly kind: string;
  readonly state: Record<string, unknown>;
}

/** A compiled agent's node, as `SessionAgent.compiled` holds it. */
export type CompiledBundle = CompiledRuntimeAgentBundle;

/** How a session stores a compiled agent's reference: `eve.bundle`, as it always has. */
interface SerializedBundleReference {
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
 * The session's agent. A step boundary carries its `reference`, which `#context/serialize.js`
 * writes and reads back first, since the channel rehydrates from it, with `writeAgentReference`
 * and `readAgentReference` below.
 */
export const SessionAgentKey = new ContextKey<SessionAgent>(SESSION_AGENT_CONTEXT_KEY_NAME);

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

// A session's agent across a step boundary: one reference, resolved here into the port. A compiled
// agent's is `eve.bundle` with `{ nodeId, source }`, the field and bytes compiled sessions have
// always stored; a held agent's is `eve.sessionAgent` with its kind and id.

/** The agent `reference` names, loaded or held in this process. */
export async function resolveSessionAgent(reference: SessionAgentReference): Promise<SessionAgent> {
  switch (reference.kind) {
    case "bundle":
      return await loadCompiledSessionAgent({
        compiledArtifactsSource: resolveDurableCompiledArtifactsSource(reference.source),
        nodeId: reference.nodeId,
      });
    case "runtime":
      return resolveHeldSessionAgent(reference.id);
  }
}

/** The context field `reference` is stored under, and what it holds. */
export function writeAgentReference(reference: SessionAgentReference): readonly [string, unknown] {
  switch (reference.kind) {
    case "bundle": {
      const stored: SerializedBundleReference = {
        nodeId: reference.nodeId,
        source: reference.source,
      };
      return [BUNDLE_CONTEXT_KEY_NAME, stored];
    }
    case "runtime":
      return [SESSION_AGENT_CONTEXT_KEY_NAME, reference];
  }
}

/** The reference a serialized context's agent field holds, if it has one. */
export function readAgentReference(
  data: Readonly<Record<string, unknown>>,
): SessionAgentReference | undefined {
  const bundle = data[BUNDLE_CONTEXT_KEY_NAME] as SerializedBundleReference | undefined;
  if (bundle !== undefined) return compiledReference(bundle);
  return data[SESSION_AGENT_CONTEXT_KEY_NAME] as SessionAgentReference | undefined;
}

/** A compiled agent's reference, from the `{ nodeId, source }` a session stores. */
function compiledReference(stored: SerializedBundleReference): BundleReference {
  return { kind: "bundle", nodeId: stored.nodeId, source: stored.source };
}
