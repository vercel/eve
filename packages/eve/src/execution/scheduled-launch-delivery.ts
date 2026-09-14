import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/** Hides a scheduled background launch while preserving its turn boundary. */
export function scheduledLaunchDeliveryEvent(
  event: UnstampedMessageStreamEvent,
  input: {
    readonly isFirstTurn: boolean;
    readonly isScheduled: boolean;
    readonly taskPhase: "none" | "initiating" | "pending" | "settled" | undefined;
  },
): UnstampedMessageStreamEvent | undefined {
  if (!input.isFirstTurn || !input.isScheduled || input.taskPhase !== "initiating") return event;
  if (event.type === "message.appended" || event.type === "result.completed") return undefined;
  if (event.type === "message.completed") {
    return { ...event, data: { ...event.data, message: null } };
  }
  return event;
}
