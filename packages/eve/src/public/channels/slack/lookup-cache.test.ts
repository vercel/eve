import { describe, expect, it } from "vitest";

import { createSlackLookupCache } from "#public/channels/slack/lookup-cache.js";

describe("Slack lookup cache", () => {
  it("keeps a value set during an in-flight load instead of the load's result", async () => {
    const cache = createSlackLookupCache<boolean>({ failedTtlMs: 60_000, ttlMs: 60_000 });
    const pending = Promise.withResolvers<{ value: boolean }>();

    const loading = cache.getOrLoad("C01", () => pending.promise);
    cache.set("C01", true);
    pending.resolve({ value: false });

    await expect(loading).resolves.toBe(false);
    await expect(cache.getOrLoad("C01", async () => ({ value: false }))).resolves.toBe(true);
  });

  it("drops a rejected load so the next lookup retries", async () => {
    const cache = createSlackLookupCache<string>({ failedTtlMs: 60_000, ttlMs: 60_000 });

    await expect(
      cache.getOrLoad("C01", async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");
    await expect(cache.getOrLoad("C01", async () => ({ value: "fresh" }))).resolves.toBe("fresh");
  });

  it("evicts the oldest entry once full", async () => {
    const cache = createSlackLookupCache<string>({
      failedTtlMs: 60_000,
      maxEntries: 2,
      ttlMs: 60_000,
    });
    cache.set("A", "a");
    cache.set("B", "b");
    cache.set("C", "c");

    await expect(cache.getOrLoad("A", async () => ({ value: "reloaded" }))).resolves.toBe(
      "reloaded",
    );
    await expect(cache.getOrLoad("C", async () => ({ value: "reloaded" }))).resolves.toBe("c");
  });
});
