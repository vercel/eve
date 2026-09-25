import type { ContextContainer } from "#context/container.js";
import {
  ActivityPendingBlockersKey,
  ActivityRootTurnIdKey,
  TurnTaskDeliveryKey,
  TurnDeliveryFailedKey,
} from "#context/keys.js";
import type { RequestEventMetadata, UnstampedMessageStreamEvent } from "#protocol/message.js";

export function requestEventMetadata(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
  delivered = true,
): RequestEventMetadata | undefined {
  const id = ctx.get(ActivityRootTurnIdKey);
  if (id === undefined) return undefined;
  const phase = ctx.get(TurnTaskDeliveryKey) ?? "none";
  let outcome: RequestEventMetadata["outcome"];
  if (event.type === "turn.failed" || event.type === "session.failed") outcome = "failed";
  else if (event.type === "turn.cancelled") outcome = "cancelled";
  else if (
    event.type === "turn.completed" &&
    phase !== "initiating" &&
    phase !== "pending" &&
    (ctx.get(ActivityPendingBlockersKey)?.length ?? 0) === 0
  )
    outcome = ctx.get(TurnDeliveryFailedKey) ? "failed" : "completed";
  return {
    id,
    phase,
    ...(!delivered ? { delivered: false as const } : {}),
    ...(outcome === undefined ? {} : { outcome }),
  };
}
