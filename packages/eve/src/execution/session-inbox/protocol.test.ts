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
      operationId: undefined,
      payloads: [{ message: "hello" }],
      requestId: undefined,
      scheduleId: undefined,
      title: undefined,
      turnPolicy: undefined,
    });
  });

  it("keeps the schedule that sent a message", () => {
    expect(
      decodeSessionInboxPayload({
        kind: "send",
        payload: { message: "Post the digest." },
        scheduleId: "daily-digest",
      }),
    ).toMatchObject({ kind: "deliver", scheduleId: "daily-digest" });
  });

  it("keeps the operation id of an owner's message", () => {
    expect(
      decodeSessionInboxPayload({
        kind: "send",
        operationId: "turn-1:call-2",
        payload: { message: "Mention the price." },
      }),
    ).toMatchObject({ kind: "deliver", operationId: "turn-1:call-2" });
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

  it("accepts a cancel with a turn guard and rejects a malformed one", () => {
    expect(decodeSessionInboxPayload({ kind: "cancel", turnId: "turn_2" })).toEqual({
      kind: "cancel",
      turnId: "turn_2",
    });
    for (const invalid of [
      { kind: "cancel", turnId: "" },
      { kind: "cancel", turnId: 2 },
    ]) {
      expect(() => decodeSessionInboxPayload(invalid)).toThrowError(SessionInboxPayloadError);
    }
  });

  it("refuses a cancel that still names the removed task options", () => {
    for (const removed of [
      { kind: "cancel", taskId: "research-7k2m9q" },
      { kind: "cancel", tasks: true },
    ]) {
      expect(() => decodeSessionInboxPayload(removed)).toThrowError(
        "Session cancel: 'taskId' and 'tasks' are no longer supported",
      );
    }
  });
});
