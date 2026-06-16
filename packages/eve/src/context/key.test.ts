import { describe, expect, it } from "vitest";

import { ContextKey, resolveKey } from "#context/key.js";

describe("ContextKey", () => {
  it("registers in the global key registry", () => {
    const key = new ContextKey<string>("test.registry");
    expect(resolveKey("test.registry")).toBe(key);
  });

  it("returns undefined for unknown key names", () => {
    expect(resolveKey("test.nonexistent.key")).toBeUndefined();
  });

  it("stores codec when provided via options", () => {
    const key = new ContextKey<number>("test.withCodec", {
      codec: {
        deserialize: (data) => data as number,
        serialize: (value) => value,
      },
    });

    expect(key.codec).toBeDefined();
    expect(key.codec?.serialize(42)).toBe(42);
  });

  it("does not expose an initial factory", () => {
    const key = new ContextKey<{ count: number }>("test.withoutInitial");
    expect("initial" in key).toBe(false);
  });

  it("throws when a name collides with a differing codec presence", () => {
    new ContextKey<number>("test.collision.codec", {
      codec: { deserialize: (data) => data as number, serialize: (value) => value },
    });

    // A codec-less key under the same name would win the registry and silently
    // break serialization for the codec-carrying key.
    expect(() => new ContextKey<number>("test.collision.codec")).toThrow(/collision/);
  });

  it("allows re-registering the same name with matching codec presence", () => {
    new ContextKey<string>("test.collision.codecless");
    expect(() => new ContextKey<string>("test.collision.codecless")).not.toThrow();

    const codec = {
      deserialize: (data: unknown) => data as number,
      serialize: (value: number) => value,
    };
    new ContextKey<number>("test.collision.bothcodec", { codec });
    expect(() => new ContextKey<number>("test.collision.bothcodec", { codec })).not.toThrow();
  });
});
