import { describe, expect, it } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { answersIdempotencyKey } from "#execution/proxied-deliver-step.js";

function delivery(...deliveryIds: string[]): DeliverHookPayload {
  return {
    kind: "deliver",
    deliveryMetadata: deliveryIds.map((deliveryId, payloadIndex) => ({
      channelKind: "http",
      channelName: "http",
      deliveryId,
      payloadIndex,
    })),
    payloads: deliveryIds.map(() => ({ answers: [{ interactionId: "approval-1" }] })),
  };
}

describe("answersIdempotencyKey", () => {
  it("names one delivery's answers to one child the same way on every retry", async () => {
    const key = await answersIdempotencyKey(delivery("d-1"), "child-a");
    expect(key).toMatch(/^eve-answers:[0-9a-f]{64}$/);
    await expect(answersIdempotencyKey(delivery("d-1"), "child-a")).resolves.toBe(key);
    // Another child, or another delivery, is another set of answers.
    await expect(answersIdempotencyKey(delivery("d-1"), "child-b")).resolves.not.toBe(key);
    await expect(answersIdempotencyKey(delivery("d-2"), "child-a")).resolves.not.toBe(key);
  });

  it("names nothing for a delivery without ids, which two deliveries could otherwise share", async () => {
    await expect(answersIdempotencyKey(delivery(), "child-a")).resolves.toBeUndefined();
  });
});
