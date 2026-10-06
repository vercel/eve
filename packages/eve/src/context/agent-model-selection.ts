import type { LanguageModel } from "ai";

import type { AgentModelSelection } from "#dynamic/definition.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

interface AgentModelSelectionInternals {
  /** Live provider instance from a `step.started` selection; not serializable. */
  readonly model?: LanguageModel;
  readonly reference: RuntimeModelReference;
}

const selectionInternals = new WeakMap<object, AgentModelSelectionInternals>();

/**
 * Wraps the effective model for `ctx.model`. The runtime reference stays
 * hidden so a dynamic subagent that returns the selection reuses it as-is
 * instead of rebuilding the model from its id.
 */
export function createAgentModelSelection(input: {
  readonly model?: LanguageModel;
  /** Node whose compiled modules hold the reference's `source`. */
  readonly nodeId: string;
  readonly reference: RuntimeModelReference;
}): AgentModelSelection {
  const reference =
    input.reference.source === undefined || input.reference.sourceNodeId !== undefined
      ? input.reference
      : { ...input.reference, sourceNodeId: input.nodeId };
  const selection: AgentModelSelection = Object.freeze({
    id: reference.id,
    ...(reference.contextWindowTokens === undefined
      ? undefined
      : { contextWindowTokens: reference.contextWindowTokens }),
  });
  selectionInternals.set(selection, { model: input.model, reference });
  return selection;
}

/** Returns the hidden runtime selection behind a `ctx.model` value, if it is one. */
export function readAgentModelSelection(value: unknown): AgentModelSelectionInternals | undefined {
  return typeof value === "object" && value !== null ? selectionInternals.get(value) : undefined;
}
