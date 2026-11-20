import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { SessionAgentReference } from "#runtime/sessions/session-agent.js";

export interface AgentSessionBundle {
  readonly nodeId?: string;
  readonly source: DurableCompiledArtifactsSource;
}

export interface AgentSessionOwner {
  readonly bundle: AgentSessionBundle;
}

export function agentSessionOwner(reference: SessionAgentReference): AgentSessionOwner {
  return { bundle: { nodeId: reference.nodeId, source: reference.source } };
}

export function ownerFieldsOf(input: AgentSessionOwner): AgentSessionOwner {
  return { bundle: input.bundle };
}

export function ownerReference(owner: AgentSessionOwner): SessionAgentReference {
  return { kind: "bundle", nodeId: owner.bundle.nodeId, source: owner.bundle.source };
}
