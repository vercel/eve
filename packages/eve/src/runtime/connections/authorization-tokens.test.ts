import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import {
  ConnectionAuthorizationTokensKey,
  evictCachedToken,
  readCachedToken,
  writeCachedToken,
} from "#runtime/connections/authorization-tokens.js";

const APP = "app";
const ALICE = "user:jwt:alice";
const BOB = "user:jwt:bob";

describe("authorization-tokens cache", () => {
  it("returns undefined when no cache is present", () => {
    const ctx = new ContextContainer();
    expect(readCachedToken(ctx, "linear", APP)).toBeUndefined();
  });

  it("returns the cached token when unexpired", () => {
    const ctx = new ContextContainer();
    writeCachedToken(ctx, "linear", APP, { token: "abc" });
    expect(readCachedToken(ctx, "linear", APP)).toEqual({ token: "abc" });
  });

  it("returns the cached token when expiresAt is in the future", () => {
    const ctx = new ContextContainer();
    const future = Date.now() + 60_000;
    writeCachedToken(ctx, "linear", APP, { token: "abc", expiresAt: future });
    expect(readCachedToken(ctx, "linear", APP)).toEqual({ token: "abc", expiresAt: future });
  });

  it("treats an expired entry as a cache miss", () => {
    const ctx = new ContextContainer();
    const past = Date.now() - 1_000;
    writeCachedToken(ctx, "linear", APP, { token: "abc", expiresAt: past });
    expect(readCachedToken(ctx, "linear", APP)).toBeUndefined();
  });

  it("writes additional entries without overwriting existing ones", () => {
    const ctx = new ContextContainer();
    writeCachedToken(ctx, "linear", APP, { token: "a" });
    writeCachedToken(ctx, "github", APP, { token: "b" });
    expect(ctx.get(ConnectionAuthorizationTokensKey)).toEqual({
      github: { [APP]: { token: "b" } },
      linear: { [APP]: { token: "a" } },
    });
  });

  it("overwrites an existing entry on re-write", () => {
    const ctx = new ContextContainer();
    writeCachedToken(ctx, "linear", APP, { token: "old" });
    writeCachedToken(ctx, "linear", APP, { token: "new" });
    expect(readCachedToken(ctx, "linear", APP)).toEqual({ token: "new" });
  });

  it("stores distinct tokens for different principals on the same connection", () => {
    const ctx = new ContextContainer();
    writeCachedToken(ctx, "linear", ALICE, { token: "alice-token" });
    writeCachedToken(ctx, "linear", BOB, { token: "bob-token" });
    expect(readCachedToken(ctx, "linear", ALICE)).toEqual({ token: "alice-token" });
    expect(readCachedToken(ctx, "linear", BOB)).toEqual({ token: "bob-token" });
  });

  it("evicts a cached token so a rejected bearer is not reused", () => {
    const ctx = new ContextContainer();
    writeCachedToken(ctx, "notion", ALICE, { token: "stale" });
    evictCachedToken(ctx, "notion", ALICE);
    expect(readCachedToken(ctx, "notion", ALICE)).toBeUndefined();
  });

  it("eviction leaves other principals on the same connection intact", () => {
    const ctx = new ContextContainer();
    writeCachedToken(ctx, "notion", ALICE, { token: "alice-token" });
    writeCachedToken(ctx, "notion", BOB, { token: "bob-token" });
    evictCachedToken(ctx, "notion", ALICE);
    expect(readCachedToken(ctx, "notion", ALICE)).toBeUndefined();
    expect(readCachedToken(ctx, "notion", BOB)).toEqual({ token: "bob-token" });
  });

  it("eviction is a no-op when nothing is cached", () => {
    const ctx = new ContextContainer();
    expect(() => evictCachedToken(ctx, "notion", ALICE)).not.toThrow();
    expect(readCachedToken(ctx, "notion", ALICE)).toBeUndefined();
  });

  it("stores cached tokens in virtual context so they never reach the durable payload", () => {
    const ctx = new ContextContainer();
    writeCachedToken(ctx, "linear", ALICE, { token: "alice-token" });

    expect(readCachedToken(ctx, "linear", ALICE)).toEqual({ token: "alice-token" });
    expect(serializeContext(ctx)[ConnectionAuthorizationTokensKey.name]).toBeUndefined();

    ctx.clearVirtualContext();
    expect(readCachedToken(ctx, "linear", ALICE)).toBeUndefined();
  });
});
