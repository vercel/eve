import { describe, expect, it } from "vitest";

import {
  decodePageToken,
  decodeTaskId,
  encodePageToken,
  encodeTaskId,
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
