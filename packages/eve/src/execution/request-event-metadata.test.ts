import { describe, expect, it } from "vitest";
import { ContextContainer } from "#context/container.js";
import {
  ActivityRootTurnIdKey,
  ActivityPendingBlockersKey,
  TurnTaskDeliveryKey,
} from "#context/keys.js";
import { requestEventMetadata } from "#execution/request-event-metadata.js";
import { updateActivityRootForDelivery } from "#execution/activity-cohort.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

function event(type: string): UnstampedMessageStreamEvent {
  return { type, data: { turnId: "continuation", sequence: 2 } } as UnstampedMessageStreamEvent;
}

describe("request lifecycle metadata", () => {
  it("owns direct requests without an activity observer and retains background ownership", () => {
    const ctx = new ContextContainer();
    updateActivityRootForDelivery({
      ctx,
      activeTurnId: "A",
      delivery: { kind: "deliver", payloads: [{ message: "request A" }] },
      sessionState: undefined,
    });
    expect(requestEventMetadata(ctx, event("turn.completed"))).toEqual({
      id: "A",
      phase: "none",
      outcome: "completed",
    });
    updateActivityRootForDelivery({
      ctx,
      activeTurnId: "B",
      delivery: { kind: "deliver", payloads: [{ message: "request B" }] },
      sessionState: undefined,
    });
    expect(requestEventMetadata(ctx, event("turn.completed"))?.id).toBe("B");
    ctx.set(ActivityPendingBlockersKey, ["B-question"]);
    updateActivityRootForDelivery({
      ctx,
      activeTurnId: "C",
      taskRootTurnId: "A",
      sessionState: undefined,
    });
    expect(requestEventMetadata(ctx, event("turn.completed"))).toMatchObject({
      id: "A",
      outcome: "completed",
    });
  });

  it.each(["initiating", "pending"] as const)("does not complete a %s response", (phase) => {
    const ctx = new ContextContainer();
    ctx.set(ActivityRootTurnIdKey, "A");
    ctx.set(TurnTaskDeliveryKey, phase);
    expect(requestEventMetadata(ctx, event("turn.completed"))).toEqual({ id: "A", phase });
  });

  it("requires all input blockers to settle, and never treats errors or cancellation as completion", () => {
    const ctx = new ContextContainer();
    ctx.set(ActivityRootTurnIdKey, "A");
    ctx.set(TurnTaskDeliveryKey, "settled");
    ctx.set(ActivityPendingBlockersKey, ["question"]);
    expect(requestEventMetadata(ctx, event("turn.completed"))?.outcome).toBeUndefined();
    expect(requestEventMetadata(ctx, event("turn.failed"))?.outcome).toBe("failed");
    expect(requestEventMetadata(ctx, event("turn.cancelled"))?.outcome).toBe("cancelled");
    ctx.delete(ActivityPendingBlockersKey);
    expect(requestEventMetadata(ctx, event("turn.completed"))?.outcome).toBe("completed");
    expect(requestEventMetadata(ctx, event("message.completed"))?.outcome).toBeUndefined();
  });
});
