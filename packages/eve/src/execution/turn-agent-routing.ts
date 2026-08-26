import type { ContextContainer } from "#context/container.js";
import { DefaultSandboxOwnerNodeIdKey, PendingTurnAgentNodeIdKey } from "#context/keys.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

/** Resolves the durable session default and the bundle selected for this turn. */
export async function resolveTurnAgentBundles(
  ctx: ContextContainer,
  input: { readonly agentNodeId?: string; readonly defaultBundle?: unknown },
): Promise<{ readonly bundle: CompiledBundle; readonly defaultBundle: CompiledBundle }> {
  const defaultBundle = await resolveDefaultBundle(ctx, input.defaultBundle);
  ctx.set(
    DefaultSandboxOwnerNodeIdKey,
    defaultBundle.graph.root.sandboxRegistry.sandbox?.inheritance?.nodeId ??
      defaultBundle.graph.root.nodeId,
  );
  const activeBundle = ctx.require(BundleKey);
  const bundle =
    input.agentNodeId === undefined
      ? defaultBundle
      : input.agentNodeId === activeBundle.nodeId
        ? activeBundle
        : await getCompiledRuntimeAgentBundle({
            compiledArtifactsSource: defaultBundle.compiledArtifactsSource,
            nodeId: input.agentNodeId,
          });
  if (bundle !== defaultBundle) ctx.set(BundleKey, bundle);
  return { bundle, defaultBundle };
}

/** Persists a selected node only while its turn is awaiting HITL or authorization. */
export function updatePendingTurnAgent(
  ctx: ContextContainer,
  agentNodeId: string | undefined,
  defaultBundle: CompiledBundle,
  session: HarnessSession,
): void {
  const pending =
    hasPendingInputBatch(session.state) || getPendingAuthorization(session.state) !== undefined;
  if (pending && agentNodeId !== undefined && agentNodeId !== defaultBundle.nodeId) {
    ctx.set(PendingTurnAgentNodeIdKey, agentNodeId);
  } else {
    ctx.delete(PendingTurnAgentNodeIdKey);
  }
}

async function resolveDefaultBundle(
  ctx: ContextContainer,
  serializedDefaultBundle: unknown,
): Promise<CompiledBundle> {
  const activeBundle = ctx.require(BundleKey);
  if (serializedDefaultBundle === undefined) return activeBundle;
  const defaultNodeId = (serializedDefaultBundle as { readonly nodeId?: unknown }).nodeId;
  if (activeBundle.nodeId === defaultNodeId) return activeBundle;
  const codec = BundleKey.codec;
  if (codec === undefined) throw new Error('Context key "eve.bundle" is missing a codec.');
  return await codec.deserialize(serializedDefaultBundle, ctx);
}
