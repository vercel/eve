import type { TaskSettledStreamEvent } from "#protocol/message.js";
import type { EveDynamicToolPart } from "#client/message-reducer-types.js";
import { approvedApproval } from "#client/message-action-parts.js";

/**
 * Settles a task call's tool part, whose `action.result` was only the start
 * receipt. A cancelled task already ran, so it settles as an error rather than
 * `output-denied`, which marks calls that never ran.
 */
export function createSettledTaskPart(
  existing: EveDynamicToolPart,
  event: TaskSettledStreamEvent,
): EveDynamicToolPart {
  const settledPartBase = {
    approval: approvedApproval(existing),
    input: existing.input,
    stepIndex: existing.stepIndex,
    toolCallId: existing.toolCallId,
    toolMetadata: existing.toolMetadata,
    toolName: existing.toolName,
    type: "dynamic-tool" as const,
  };

  switch (event.data.status) {
    case "completed":
      return { ...settledPartBase, output: event.data.output, state: "output-available" };
    case "failed":
      return {
        ...settledPartBase,
        errorText: event.data.error?.message ?? "Task failed.",
        state: "output-error",
      };
    case "cancelled":
      return { ...settledPartBase, errorText: "Task was cancelled.", state: "output-error" };
  }
}
