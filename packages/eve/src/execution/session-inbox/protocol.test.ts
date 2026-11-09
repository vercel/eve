import { describe, expect, it } from "vitest";

import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.js";

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
      title: undefined,
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
    for (const idempotencyKey of ["", "x".repeat(257), 1]) {
      expect(() =>
        decodeSessionInboxPayload({ kind: "send", idempotencyKey, payload: { message: "hello" } }),
      ).toThrowError(SessionInboxPayloadError);
    }
  });

  it("accepts a channel-state control whose state is a JSON object", () => {
    expect(
      decodeSessionInboxPayload({
        deliveryId: "delivery-1",
        kind: "channel-state",
        state: { prompts: { linear: "https://hooks.slack.com/actions/1" } },
      }),
    ).toEqual({
      deliveryId: "delivery-1",
      kind: "channel-state",
      state: { prompts: { linear: "https://hooks.slack.com/actions/1" } },
    });
  });

  it("rejects a channel-state control without a delivery id or a JSON object state", () => {
    for (const payload of [
      { kind: "channel-state", state: {} },
      { deliveryId: "", kind: "channel-state", state: {} },
      { deliveryId: "delivery-1", kind: "channel-state" },
      { deliveryId: "delivery-1", kind: "channel-state", state: null },
      { deliveryId: "delivery-1", kind: "channel-state", state: ["linear"] },
      { deliveryId: "delivery-1", kind: "channel-state", state: "linear" },
      { deliveryId: "delivery-1", kind: "channel-state", state: { at: new Date(0) } },
    ]) {
      expect(() => decodeSessionInboxPayload(payload), JSON.stringify(payload)).toThrowError(
        SessionInboxPayloadError,
      );
    }
  });
});
