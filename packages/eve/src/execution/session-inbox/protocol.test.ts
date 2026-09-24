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

  it("accepts only current delivery and control kinds", () => {
    expect(decodeSessionInboxPayload({ kind: "deliver", payloads: [] })).toEqual({
      kind: "deliver",
      payloads: [],
    });
    expect(() => decodeSessionInboxPayload({ kind: "legacy-send" })).toThrowError(
      SessionInboxPayloadError,
    );
  });

  it("accepts task cancellation and rejects malformed cancel options", () => {
    expect(decodeSessionInboxPayload({ kind: "cancel", taskId: "remind-q4x1ze" })).toEqual({
      kind: "cancel",
      taskId: "remind-q4x1ze",
    });
    expect(decodeSessionInboxPayload({ kind: "cancel", tasks: true })).toEqual({
      kind: "cancel",
      tasks: true,
    });
    for (const invalid of [
      { kind: "cancel", taskId: "" },
      { kind: "cancel", taskId: "x".repeat(129) },
      { kind: "cancel", tasks: "yes" },
      { kind: "cancel", taskId: "remind-q4x1ze", tasks: true },
    ]) {
      expect(() => decodeSessionInboxPayload(invalid)).toThrowError(SessionInboxPayloadError);
    }
  });
});
