import { describe, expect, it } from "vitest";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import type { DeliverHookPayload } from "#channel/types.js";

const delivery = (...ids: string[]): DeliverHookPayload => ({
  kind: "deliver",
  payloads: ids.map((message) => ({ message })),
  deliveryMetadata: ids.map((deliveryId, payloadIndex) => ({
    deliveryId,
    payloadIndex,
    channelKind: "http",
    channelName: "test",
  })),
});

describe("delivery id admission", () => {
  it("reports only unadmitted payloads, including mixed and id-less batches", () => {
    const queue = new SessionInputQueue();
    expect(queue.hasUnadmitted(delivery("A"))).toBe(true);
    queue.enqueueDelivery(delivery("A"));
    queue.takeNext();
    expect(queue.hasUnadmitted(delivery("A"))).toBe(false);
    expect(queue.hasUnadmitted(delivery("A", "B"))).toBe(true);
    expect(queue.hasUnadmitted({ kind: "deliver", payloads: [{ message: "no id" }] })).toBe(true);
    expect(queue.hasUnadmitted(delivery())).toBe(false);
    queue.markAdmitted(["B"]);
    expect(queue.hasUnadmitted(delivery("A", "B"))).toBe(false);
  });
  it("admits overlapping repeated delivery ids only once, even after selection", async () => {
    const queue = new SessionInputQueue();
    expect((await admitSessionInboxPayload(delivery("A"), { queue })).kind).toBe("delivery");
    expect((await admitSessionInboxPayload(delivery("A"), { queue })).kind).toBe("consumed");
    expect(queue.pendingCount).toBe(1);
    expect(queue.takeNext()?.kind).toBe("turn");
    expect((await admitSessionInboxPayload(delivery("A"), { queue })).kind).toBe("consumed");
    expect(queue.takeNext()).toBeUndefined();
  });
  it("keeps only B in a coalesced A B delivery after A", () => {
    const queue = new SessionInputQueue();
    queue.enqueueDelivery(delivery("A"));
    expect(queue.enqueueDelivery(delivery("A", "B"))?.delivery).toEqual(delivery("B"));
  });
  it("consumes a resend of the seeded initial delivery", async () => {
    const queue = new SessionInputQueue();
    queue.markAdmitted(["initial"]);
    expect((await admitSessionInboxPayload(delivery("initial"), { queue })).kind).toBe("consumed");
    expect(queue.pendingCount).toBe(0);
  });
  it("does not deduplicate payloads without ids", () => {
    const queue = new SessionInputQueue();
    const input: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "hello" }] };
    queue.enqueueDelivery(input);
    queue.enqueueDelivery(input);
    expect(queue.pendingCount).toBe(2);
  });
});
