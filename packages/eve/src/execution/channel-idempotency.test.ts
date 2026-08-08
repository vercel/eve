import { describe, expect, it } from "vitest";

import {
  CHANNEL_IDEMPOTENCY_WINDOW_SIZE,
  createChannelIdempotencyGuard,
} from "#execution/channel-idempotency.js";

describe("createChannelIdempotencyGuard", () => {
  it("accepts unkeyed deliveries without retaining them", () => {
    const guard = createChannelIdempotencyGuard();

    expect(guard.accept(undefined)).toBe(true);
    expect(guard.accept(undefined)).toBe(true);
  });

  it("rejects a repeated initial or follow-up key", () => {
    const guard = createChannelIdempotencyGuard("initial");

    expect(guard.accept("initial")).toBe(false);
    expect(guard.accept("follow-up")).toBe(true);
    expect(guard.accept("follow-up")).toBe(false);
  });

  it("evicts keys in deterministic insertion order", () => {
    const guard = createChannelIdempotencyGuard("oldest");
    for (let index = 1; index < CHANNEL_IDEMPOTENCY_WINDOW_SIZE; index += 1) {
      expect(guard.accept(`key-${String(index)}`)).toBe(true);
    }

    expect(guard.accept("newest")).toBe(true);
    expect(guard.accept("oldest")).toBe(true);
    expect(guard.accept("newest")).toBe(false);
  });
});
