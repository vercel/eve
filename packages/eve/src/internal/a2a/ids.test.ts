import { describe, expect, it } from "vitest";

import {
  decodePageToken,
  decodeTaskId,
  deliveryIdForMessage,
  encodePageToken,
  encodeTaskId,
  messageIdOfDelivery,
  messageIdempotencyKey,
} from "./ids.js";

describe("A2A ids", () => {
  it("round-trips a task ID and refuses any other encoding of it", () => {
    const ref = { deliveryId: "7f3c-delivery", sessionId: "wrun_01ABC" };
    const id = encodeTaskId(ref);
    expect(decodeTaskId(id)).toEqual(ref);
    expect(decodeTaskId(`${id}=`)).toBeUndefined();
    expect(decodeTaskId("not a task")).toBeUndefined();
    expect(decodeTaskId(Buffer.from("only-a-session").toString("base64url"))).toBeUndefined();
    expect(decodeTaskId(Buffer.from("a\nb\nc").toString("base64url"))).toBeUndefined();
  });

  it("names a message's delivery after its messageId, reversibly", () => {
    for (const messageId of ["m-1", "with\nnewline", "x".repeat(256), "名".repeat(256)]) {
      const deliveryId = deliveryIdForMessage(messageId);
      expect(messageIdOfDelivery(deliveryId)).toBe(messageId);
      // Even the longest message ID leaves a task ID the request schemas accept.
      expect(encodeTaskId({ deliveryId, sessionId: "wrun_01ABC" }).length).toBeLessThan(2048);
    }
    expect(deliveryIdForMessage("m-1")).not.toBe(deliveryIdForMessage("m-2"));
    expect(messageIdOfDelivery("8a8f7c62-1d2e-4c3b-9f4a-5b6c7d8e9f00")).toBeUndefined();
    expect(messageIdOfDelivery("a2a_bS0x=")).toBeUndefined();
  });

  it("scopes a message's idempotency key to its owner", () => {
    const alice = messageIdempotencyKey("owner:alice", "m-1");
    expect(alice).toBe(messageIdempotencyKey("owner:alice", "m-1"));
    expect(alice).not.toBe(messageIdempotencyKey("owner:bob", "m-1"));
    expect(alice).not.toBe(messageIdempotencyKey("owner:alice", "m-2"));
    expect(alice.startsWith("a2a:")).toBe(true);
    expect(alice.length).toBeLessThanOrEqual(256);
  });

  it("reads a page token only in the context that minted it", () => {
    const token = encodePageToken("wrun_1", 1_700_000_000_000, 12);
    expect(decodePageToken(token, "wrun_1")).toEqual({ at: 1_700_000_000_000, seq: 12 });
    expect(decodePageToken(token, "wrun_2")).toBeNull();
    expect(decodePageToken("garbage", "wrun_1")).toBeNull();
    expect(
      decodePageToken(Buffer.from('["wrun_1",1.5,2]').toString("base64url"), "wrun_1"),
    ).toBeNull();
  });
});
