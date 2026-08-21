import type { SessionStateMap } from "#harness/types.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

export const TASK_DELIVERY_CONTEXT_LABEL = "[Task state]";

export const TASK_DELIVERY_PENDING_INSTRUCTION = `Background task control: incomplete cohort
This framework-authored instruction overrides any earlier instruction to report, summarize, acknowledge, or otherwise handle background results.

The accompanying ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists tasks started by the same parent turn. At least one of those tasks is still pending, so the combined report is not ready.

Action:
- You may call tools only if the newly delivered task result requires immediate action.
- Otherwise, take no action.

Delivery:
- Do not report completed tasks or partial results.
- Do not provide progress, status, an acknowledgement, or a waiting message.
- After any necessary tool calls, your entire final text response must be exactly ${EMPTY_DELIVERY_SENTINEL} and no other text.

Incorrect: "Two of three tasks have completed."
Incorrect: "Still waiting for the remaining task."
Correct: ${EMPTY_DELIVERY_SENTINEL}`;

export const TASK_DELIVERY_SETTLED_INSTRUCTION = `Background task reporting\nThis turn was triggered by background task activity. The accompanying ${TASK_DELIVERY_CONTEXT_LABEL} message is runtime-authored and lists tasks started by the same parent turn, all settled, with every available terminal output. Do not reply with ${EMPTY_DELIVERY_SENTINEL}. Send one user-facing response that combines their useful results.`;

/** Returns model context and cohort phase for tasks started by the same parent turn as this delivery. */
export function resolveTaskDeliveryContext(input: {
  readonly state: SessionStateMap | undefined;
  readonly taskDeliveryId: string;
}): { readonly context: string; readonly phase: "pending" | "settled" } | undefined {
  const entries = getSessionTaskIndex(input.state);
  const delivered = entries.find((entry) => input.taskDeliveryId.startsWith(`${entry.taskId}:`));
  if (delivered === undefined) return undefined;

  const cohort = entries.filter((entry) => entry.createdByTurnId === delivered.createdByTurnId);
  const settled = cohort.every((entry) => entry.terminalView !== undefined);
  const tasks = cohort.map((entry) => ({
    name: entry.metadata.name,
    output: settled ? entry.terminalView?.lastOutput : undefined,
    status: entry.terminalView?.status ?? "pending",
    taskId: entry.taskId,
  }));

  return {
    context: `${TASK_DELIVERY_CONTEXT_LABEL}\n${JSON.stringify({ tasks })}`,
    phase: settled ? "settled" : "pending",
  };
}
