import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { defineMountedState, defineState } from "#public/definitions/state.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import * as manifestLoader from "#runtime/loaders/manifest.js";

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

describe("state layout admission", () => {
  it("rejects reserved mount names in an unmarked legacy context", async () => {
    const bundle = { compiledArtifactsSource: { kind: "bundled" } } as CompiledBundle;
    const deserialize = vi.spyOn(BundleKey.codec!, "deserialize").mockResolvedValue(bundle);
    try {
      // Registration in a previous graph must not turn a reserved legacy authored name
      // into proof that it belongs to the new layout.
      new ContextKey("eve:mount.v1:extensions%2Fcrm:requests");
      await expect(
        deserializeContext({
          "eve.bundle": {},
          "eve:mount.v1:extensions%2Fcrm:requests": 4,
        }),
      ).rejects.toThrow("Incompatible context state layout");
    } finally {
      deserialize.mockRestore();
    }
  });

  it("moves legacy extension state to the one mount that owns its package", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const bundle = { compiledArtifactsSource: { kind: "bundled" } } as CompiledBundle;
    const deserialize = vi.spyOn(BundleKey.codec!, "deserialize").mockImplementation(async () => {
      defineMountedState("extensions/crm", "requests", () => 0);
      return bundle;
    });
    const mount = (mountId: string) =>
      ({ mountId, packageName: "@acme/crm" }) as (typeof manifest.extensionMounts)[number];
    const loadManifest = vi
      .spyOn(manifestLoader, "loadCompiledManifest")
      .mockResolvedValue({ ...manifest, extensionMounts: [mount("extensions/crm")] });
    try {
      expect((await deserializeContext({ "eve.bundle": {} })).get(BundleKey)).toBe(bundle);
      const restored = await deserializeContext({ "eve.bundle": {}, "acme-crm.requests": 4 });
      expect(
        [...restored.entries()].map(([key, value]) => [key.name, value]).filter(([, v]) => v === 4),
      ).toEqual([["eve:mount.v1:extensions%2Fcrm:requests", 4]]);
      // Two mounts of one package shared the legacy key, so neither can claim it.
      loadManifest.mockResolvedValue({
        ...manifest,
        extensionMounts: [mount("extensions/crm"), mount("extensions/crm-eu")],
      });
      await expect(
        deserializeContext({ "eve.bundle": {}, "acme-crm.requests": 4 }),
      ).rejects.toThrow('Incompatible context state layout for key "acme-crm.requests"');
    } finally {
      deserialize.mockRestore();
      loadManifest.mockRestore();
    }
  });

  it("keeps declared legacy application state and drops state the deployment removed", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const bundle = { compiledArtifactsSource: { kind: "bundled" } } as CompiledBundle;
    const name = "test.legacy.app-owned";
    const deserialize = vi.spyOn(BundleKey.codec!, "deserialize").mockImplementation(async () => {
      defineState(name, () => 0);
      return bundle;
    });
    const loadManifest = vi
      .spyOn(manifestLoader, "loadCompiledManifest")
      .mockResolvedValue(manifest);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const restored = await deserializeContext({
        "eve.bundle": {},
        [name]: 4,
        "test.legacy.removed": { phase: "none" },
      });
      expect(restored.get(BundleKey)).toBe(bundle);
      expect([...restored.entries()].map(([key]) => key.name)).toEqual(["eve.bundle", name]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropping unknown context key"),
        expect.objectContaining({ key: "test.legacy.removed" }),
      );
    } finally {
      deserialize.mockRestore();
      loadManifest.mockRestore();
      warn.mockRestore();
    }
  });

  it("drops an unknown application key in a current-layout checkpoint", async () => {
    const bundle = { compiledArtifactsSource: { kind: "bundled" } } as CompiledBundle;
    const deserialize = vi.spyOn(BundleKey.codec!, "deserialize").mockResolvedValue(bundle);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const restored = await deserializeContext({
        "eve.bundle": {},
        "eve.stateLayout": 1,
        "test.renamed.app-owned": 4,
      });
      expect(restored.get(BundleKey)).toBe(bundle);
      expect([...restored.entries()]).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropping unknown context key"),
        expect.objectContaining({ key: "test.renamed.app-owned" }),
      );
    } finally {
      deserialize.mockRestore();
      warn.mockRestore();
    }
  });

  it("rejects unmarked reserved state even when the declaration has been removed", async () => {
    const savedName = "eve:mount.v1:extensions%2Fremoved:requests";
    new ContextKey(savedName);
    await expect(deserializeContext({ [savedName]: 4 })).rejects.toThrow(
      "Incompatible context state layout",
    );
  });

  it("keeps marked mount state in a context without a bundle", async () => {
    const name = "eve:mount.v1:extensions%2Fcrm:requests";
    const key = new ContextKey<number>(name);
    const original = new ContextContainer();
    original.set(key, 4);
    const saved = serializeContext(original);
    expect(saved["eve.stateLayout"]).toBe(1);
    expect((await deserializeContext(saved)).get(key)).toBe(4);
  });

  it("rejects an unsupported explicit layout", async () => {
    await expect(deserializeContext({ "eve.bundle": {}, "eve.stateLayout": 2 })).rejects.toThrow(
      "Incompatible context state layout",
    );
  });

  it("stamps bundle-backed context snapshots with the current layout", () => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, { compiledArtifactsSource: {} } as CompiledBundle);
    expect(serializeContext(ctx)["eve.stateLayout"]).toBe(1);
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
