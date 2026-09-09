import { getAdapterKind, type ChannelAdapter } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type { SandboxState } from "#sandbox/state.js";
import type { SandboxBackendTags } from "#shared/sandbox-backend.js";

export interface WorkflowSandboxReferenceData {
  readonly compiledArtifactsSource: CompiledBundle["compiledArtifactsSource"];
  readonly nodeId: string;
  readonly ownsSandbox: boolean;
  readonly sessionId: string;
  readonly state: SandboxState | null;
  readonly tags?: SandboxBackendTags;
}

export function createWorkflowSandboxReference(input: {
  readonly bundle: CompiledBundle;
  readonly channel: ChannelAdapter | undefined;
  readonly sandboxSessionId: string;
  readonly session: Pick<HarnessSession, "sandboxState" | "sessionId">;
  readonly state?: SandboxState;
}): WorkflowSandboxReferenceData {
  return {
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    nodeId: input.bundle.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID,
    ownsSandbox:
      input.bundle.graph.root.sandboxRegistry.sandbox?.definition.inheritsParent !== true &&
      input.sandboxSessionId === input.session.sessionId,
    sessionId: input.sandboxSessionId,
    state: input.state ?? input.session.sandboxState ?? null,
    tags: {
      agent:
        input.bundle.resolvedAgent.config?.name ??
        input.bundle.nodeId ??
        ROOT_RUNTIME_AGENT_NODE_ID,
      channel: input.channel === undefined ? "unknown" : getAdapterKind(input.channel),
      sessionId: input.session.sessionId,
    },
  };
}

export async function captureWorkflowSandboxReference(input: {
  readonly ctx: ContextContainer;
  readonly session: HarnessSession;
}): Promise<WorkflowSandboxReferenceData> {
  const channel = input.ctx.get(ChannelKey);
  const adapterState = channel?.state as Record<string, unknown> | undefined;
  const sharedSessionId = adapterState?.sandboxSessionId;
  const access = input.ctx.require(SandboxKey);
  await access.get();
  return createWorkflowSandboxReference({
    bundle: input.ctx.require(BundleKey),
    channel,
    sandboxSessionId:
      typeof sharedSessionId === "string" && sharedSessionId.length > 0
        ? sharedSessionId
        : input.session.sessionId,
    session: input.session,
    state: await access.captureState(),
  });
}
