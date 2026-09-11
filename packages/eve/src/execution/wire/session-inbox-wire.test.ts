import { describe, expect, it } from "vitest";

import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/wire/session-inbox-wire.js";

describe("session inbox payloads", () => {
  it("normalizes send into the current delivery shape", () => {
    expect(
      decodeSessionInboxPayload({
        delivery: { deliveryId: "delivery-1" },
        kind: "send",
        payload: { message: "hello" },
      }),
    ).toEqual({
      auth: undefined,
      caller: undefined,
      deliveryMetadata: [{ deliveryId: "delivery-1", payloadIndex: 0 }],
      kind: "deliver",
      payloads: [{ message: "hello" }],
      requestId: undefined,
      taskDeliveryId: undefined,
      turnPolicy: undefined,
    });
  });

  it("accepts only current delivery and control kinds", () => {
    expect(decodeSessionInboxPayload({ kind: "deliver", payloads: [] })).toEqual({
      kind: "deliver",
      payloads: [],
    });
    expect(() => decodeSessionInboxPayload({ kind: "legacy-send" })).toThrowError(
      SessionInboxPayloadError,
    );
  });
});
