import { describe, expect, it } from "vitest";
import { steeringDeliveryId } from "#execution/session/input-queue.js";
import type { DeliverHookPayload } from "#channel/types.js";

const meta = (deliveryId: string, payloadIndex: number) =>
  ({ deliveryId, payloadIndex }) as NonNullable<DeliverHookPayload["deliveryMetadata"]>[number];

describe("steeringDeliveryId", () => {
  it("names the delivery of the message, not of an answer batched before it", () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [] } as never, { message: "correction" }],
      deliveryMetadata: [meta("dlv_answer", 0), meta("dlv_message", 1)],
    };
    expect(steeringDeliveryId(delivery)).toBe("dlv_message");
  });

  it("names the only delivery of a lone message", () => {
    expect(
      steeringDeliveryId({
        kind: "deliver",
        payloads: [{ message: "correction" }],
        deliveryMetadata: [meta("dlv_only", 0)],
      }),
    ).toBe("dlv_only");
  });
});
