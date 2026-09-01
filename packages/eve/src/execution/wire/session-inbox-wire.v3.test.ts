import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { sessionInboxWire as sessionInboxWireEncoder } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV3Schema } from "#execution/wire/session-inbox-wire.v3.js";

const delivery = {
  acceptedDeploymentId: "dpl_current",
  channelKind: "channel:webhook",
  channelName: "webhook",
  deliveryId: "delivery-1",
};

describe("session inbox wire v3", () => {
  it("round-trips accepted deployment provenance", () => {
    const wire = sessionInboxWireEncoder.encode(
      { delivery, kind: "send", payload: { message: "hello" } },
      { version: 3 },
    );

    expect(wire).toMatchObject({
      deliveryMetadata: [{ ...delivery, payloadIndex: 0 }],
      version: 3,
    });
    expect(sessionInboxWireDecoder.decode(JSON.parse(JSON.stringify(wire)))).toMatchObject({
      deliveryMetadata: [{ ...delivery, payloadIndex: 0 }],
      kind: "deliver",
    });
  });

  it("omits deployment provenance for older versioned consumers", () => {
    expect(
      sessionInboxWireEncoder.encode(
        { delivery, kind: "send", payload: { message: "hello" } },
        { version: 2 },
      ),
    ).not.toHaveProperty("deliveryMetadata.0.acceptedDeploymentId");
  });

  it("carries deployment provenance through the stable raw-send fast path", () => {
    const wire = sessionInboxWireEncoder.encode(
      { delivery, kind: "send", payload: { message: "hello" } },
      { variant: "send", version: 0 },
    );

    expect(wire).toMatchObject({ delivery, kind: "send" });
    expect(sessionInboxWireDecoder.decode(JSON.parse(JSON.stringify(wire)))).toMatchObject({
      deliveryMetadata: [{ ...delivery, payloadIndex: 0 }],
    });
  });

  it("migrates frozen v2 deliveries without inventing provenance", () => {
    expect(
      sessionInboxWireDecoder.decode({
        kind: "deliver",
        payload: { message: "legacy" },
        payloads: [{ message: "legacy" }],
        version: 2,
      }),
    ).toEqual({
      auth: undefined,
      caller: undefined,
      deliveryMetadata: undefined,
      kind: "deliver",
      payloads: [{ message: "legacy" }],
      requestId: undefined,
      taskDeliveryId: undefined,
      turnPolicy: undefined,
    });
  });

  it("pins the complete schema byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxWireV3Schema, { io: "input", unrepresentable: "any" }),
      ),
    ).toMatchSnapshot();
  });
});

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}
