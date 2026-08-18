import { describe, expect, it } from "vitest";

import { sessionInboxWire as sessionInboxWireEncoder } from "#execution/wire/session-inbox-encoder.js";
import {
  sessionInboxWire as sessionInboxWireDecoder,
  SessionInboxWireError,
} from "#execution/wire/session-inbox-wire.js";

/** Every payload shape persisted before explicit wire versioning. */
const FROZEN_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly payload: string;
  readonly decoded: unknown;
}> = [
  {
    name: "legacy deliver envelope (≤0.30.4 producers)",
    payload: '{"kind":"deliver","payloads":[{"message":"legacy"}]}',
    decoded: { kind: "deliver", payloads: [{ message: "legacy" }] },
  },
  {
    name: "raw send command (0.30.5–0.30.8 producers)",
    payload:
      '{"auth":null,"delivery":{"channelKind":"http","channelName":"web","deliveryId":"delivery-0"},"kind":"send","payload":{"message":"mid"},"requestId":"req-0","taskDeliveryId":"task-delivery-0","turnPolicy":"queue"}',
    decoded: {
      auth: null,
      deliveryMetadata: [
        {
          channelKind: "http",
          channelName: "web",
          deliveryId: "delivery-0",
          payloadIndex: 0,
        },
      ],
      kind: "deliver",
      payloads: [{ message: "mid" }],
      requestId: "req-0",
      taskDeliveryId: "task-delivery-0",
      turnPolicy: "queue",
    },
  },
  {
    name: "unversioned cancel control",
    payload: '{"kind":"cancel","turnId":"turn_1"}',
    decoded: { kind: "cancel", turnId: "turn_1" },
  },
  {
    name: "unversioned session-timeout control",
    payload: '{"kind":"session-timeout"}',
    decoded: { kind: "session-timeout" },
  },
];

describe("session inbox wire v0", () => {
  it.each(FROZEN_FIXTURES)("migrates the frozen $name fixture", ({ payload, decoded }) => {
    expect(sessionInboxWireDecoder.decode(JSON.parse(payload))).toEqual(decoded);
  });

  it.each([
    ["a malformed legacy deliver", { kind: "deliver", payloads: "nope" }],
    ["a malformed legacy send", { kind: "send", payload: "nope" }],
    ["legacy send with malformed delivery metadata", { kind: "send", payload: {}, delivery: 1 }],
    ["a non-object payload", "deliver"],
  ])("rejects %s instead of reinterpreting it", (_name, payload) => {
    expect(() => sessionInboxWireDecoder.decode(payload)).toThrowError(SessionInboxWireError);
  });

  it("encodes sends for the legacy deliver cohort", () => {
    expect(
      sessionInboxWireEncoder.encode(
        { auth: null, kind: "send", payload: { message: "legacy" }, requestId: "req-0" },
        { variant: "deliver", version: 0 },
      ),
    ).toEqual({
      auth: null,
      caller: undefined,
      deliveryMetadata: undefined,
      kind: "deliver",
      payloads: [{ message: "legacy" }],
      requestId: "req-0",
      taskDeliveryId: undefined,
      turnPolicy: undefined,
    });
  });

  it("encodes sends for the legacy raw-send cohort", () => {
    expect(
      sessionInboxWireEncoder.encode(
        { kind: "send", payload: { message: "mid" } },
        { variant: "send", version: 0 },
      ),
    ).toEqual({
      auth: undefined,
      caller: undefined,
      delivery: undefined,
      kind: "send",
      payload: { message: "mid" },
      requestId: undefined,
      taskDeliveryId: undefined,
      turnPolicy: undefined,
    });
  });
});
