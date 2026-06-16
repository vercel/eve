import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";

const BaseKey = new ContextKey<string>("test.deserialize.base");
const DerivedKey = new ContextKey<string>("test.deserialize.derived", {
  codec: {
    deserialize(data, ctx) {
      return `${ctx.require(BaseKey)}:${data as string}`;
    },
    serialize(value) {
      return value;
    },
  },
});

describe("deserializeContext", () => {
  it("passes the already-hydrated context into key codecs", async () => {
    const ctx = await deserializeContext({
      [BaseKey.name]: "left",
      [DerivedKey.name]: "right",
    });

    expect(ctx.require(BaseKey)).toBe("left");
    expect(ctx.require(DerivedKey)).toBe("left:right");
  });
});

describe("serialize/deserialize error logging", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the offending key when a codec serialize throws, then rethrows", () => {
    const ThrowingKey = new ContextKey<string>("test.serialize.throwing", {
      codec: {
        deserialize: (data) => data as string,
        serialize() {
          throw new Error("codec exploded");
        },
      },
    });
    const ctx = new ContextContainer();
    ctx.set(ThrowingKey, "value");

    expect(() => serializeContext(ctx)).toThrow("codec exploded");
    const logged = errorSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("failed to serialize context key"),
    );
    expect(logged).toBeDefined();
    expect(logged![1]).toMatchObject({ key: "test.serialize.throwing" });
  });

  it("warns when a deserialized key is not registered", async () => {
    await deserializeContext({ "test.unregistered.key": "orphan" });
    const logged = warnSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("dropping unknown context key"),
    );
    expect(logged).toBeDefined();
    expect(logged![1]).toMatchObject({ key: "test.unregistered.key" });
  });
});

describe("ChannelKey codec", () => {
  it("deserializes adapters when the bundle registry is present in context", async () => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, {
      adapterRegistry: createRuntimeAdapterRegistry({ channels: [] }),
    } as CompiledBundle);

    const codec = ChannelKey.codec;
    if (codec === undefined) {
      throw new Error('Context key "eve.channel" is missing a codec.');
    }

    const adapter = await codec.deserialize(
      {
        kind: "http",
        state: {},
      },
      ctx,
    );

    expect(adapter).toEqual({ kind: "http", state: {} });
  });
});
