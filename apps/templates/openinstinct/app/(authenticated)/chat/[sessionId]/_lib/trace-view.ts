import type { SessionStreamEvent } from "eve/client";
import { call, type SessionView } from "eve/events";
import type { EveMessage } from "eve/react";
import { z } from "zod";

const backgroundWorkerDelivery =
  /^Background task (\S+) \(browser-agent\) (?:update: |needs input\.$|is cancelled\.$|is completed\.\n\nResult:\n|failed\.\n\nError:\n)/u;
const backgroundWorkerAuthorization =
  /^Background task (\S+) needs authorization\.$/u;
const workerReceiptSchema = z.object({ taskId: z.string() });
const taskCancelOutputSchema = z.object({ tasks: z.array(z.unknown()) });
const cancelledWorkerTaskSchema = z.object({
  metadata: z.object({ name: z.literal("browser-agent") }),
  status: z.literal("cancelled"),
  taskId: z.string(),
});

export type TraceView = "imessage" | "trace";

export function messagesForTraceView(
  messages: readonly EveMessage[],
  events: readonly SessionStreamEvent[],
  view: SessionView,
  traceView: TraceView
) {
  if (traceView === "trace") return messages;
  const hiddenMessageIds = backgroundWorkerDeliveryMessageIds(events, view);
  return messages.filter((message) => !hiddenMessageIds.has(message.id));
}

/**
 * Message IDs of background worker notifications in saved streams from
 * Eve < 0.61, which delivered task progress as user-role text. Current task
 * results reach the model without a delivery, so they never become messages.
 */
export function backgroundWorkerDeliveryMessageIds(
  events: readonly SessionStreamEvent[],
  view: SessionView
) {
  const taskIds = workerTaskIds(events, view);
  const cancelledTaskIds = new Set<string>();
  const messageIds = new Set<string>();

  for (const event of events) {
    if (event.type === "call.settled") {
      if (call(view, event.data.callId)?.name !== "task_cancel") continue;
      const output = taskCancelOutputSchema.safeParse(event.data.output);
      if (!output.success) continue;
      for (const value of output.data.tasks) {
        const task = cancelledWorkerTaskSchema.safeParse(value);
        if (task.success) cancelledTaskIds.add(task.data.taskId);
      }
      continue;
    }

    if (event.type !== "delivery.consumed") continue;
    const message = deliveredText(event);
    const taskId = deliveredTaskId(message);
    if (!taskId || !taskIds.has(taskId)) continue;

    const userMessageId = `${event.data.deliveryId}:user`;
    const isCancellation = message.endsWith("(browser-agent) is cancelled.");
    if (!isCancellation) messageIds.add(userMessageId);
    if (isCancellation && cancelledTaskIds.delete(taskId)) {
      messageIds.add(userMessageId);
      messageIds.add(`${event.data.turnId}:assistant`);
    }
  }

  return messageIds;
}

/** Background task IDs the browser worker reported in its receipts. */
function workerTaskIds(
  events: readonly SessionStreamEvent[],
  view: SessionView
) {
  const taskIds = new Set<string>();

  for (const event of events) {
    if (event.type !== "call.settled" || event.data.outcome !== "completed") {
      continue;
    }
    if (call(view, event.data.callId)?.name !== "browser-agent") continue;
    const receipt = workerReceiptSchema.safeParse(event.data.output);
    if (receipt.success) taskIds.add(receipt.data.taskId);
  }

  return taskIds;
}

function deliveredText(
  event: Extract<SessionStreamEvent, { type: "delivery.consumed" }>
) {
  return event.data.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n");
}

function deliveredTaskId(message: string) {
  return (
    backgroundWorkerDelivery.exec(message)?.[1] ??
    backgroundWorkerAuthorization.exec(message)?.[1]
  );
}
