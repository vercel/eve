import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { HeldReference, SessionAgentReference } from "#runtime/sessions/session-agent.js";

// The agent that owns a workflow tool call, as the call's step inputs (`AgentSessionContext`,
// `WorkflowStepSandbox`) carry it. Types only beside two pure functions, so a workflow body can
// import it.

/** A compiled agent's reference, in the shape step inputs have always stored it. */
export interface AgentSessionBundle {
  readonly nodeId?: string;
  readonly source: DurableCompiledArtifactsSource;
}

/**
 * The agent whose session made the call, which resolves the agent names `ctx.agent` opens, as
 * step inputs carry it: a compiled agent's under `bundle`, the field and bytes they have always
 * had, so inputs recorded before held agents replay as they are; an agent this process holds
 * under `agent`.
 */
export type AgentSessionOwner =
  | { readonly bundle: AgentSessionBundle; readonly agent?: never }
  | { readonly agent: HeldReference; readonly bundle?: never };

/** The step-input owner fields for the agent `reference` names. */
export function agentSessionOwner(reference: SessionAgentReference): AgentSessionOwner {
  switch (reference.kind) {
    case "bundle":
      return { bundle: { nodeId: reference.nodeId, source: reference.source } };
    case "runtime":
      return { agent: reference };
  }
}

/** Just the owner fields of `input`, as it holds them, for the next step input to carry. */
export function ownerFieldsOf(input: AgentSessionOwner): AgentSessionOwner {
  return input.bundle === undefined ? { agent: input.agent } : { bundle: input.bundle };
}

/** The reference a step input's owner fields hold. */
export function ownerReference(owner: AgentSessionOwner): SessionAgentReference {
  return owner.bundle === undefined
    ? owner.agent
    : { kind: "bundle", nodeId: owner.bundle.nodeId, source: owner.bundle.source };
}
