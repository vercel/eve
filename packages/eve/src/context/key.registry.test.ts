import { describe, expect, it, vi } from "vitest";

describe("keyRegistry chunk-isolation (GTMENG-1154 regression)", () => {
  it("a key registered in one module evaluation is resolvable from another", async () => {
    vi.resetModules();
    const moduleA = await import("#context/key.js");
    const alice = new moduleA.ContextKey<string>("test.registry.cross-module.alice");

    vi.resetModules();
    const moduleB = await import("#context/key.js");

    expect(moduleB.resolveKey("test.registry.cross-module.alice")).toBe(alice);
  });

  it("the registry is mounted on globalThis under the canonical symbol", async () => {
    const registryKey = Symbol.for("eve.context-key-registry");
    const { ContextKey } = await import("#context/key.js");

    const registry = (globalThis as Record<symbol, unknown>)[registryKey];
    expect(registry).toBeInstanceOf(Map);

    const canary = new ContextKey<number>("test.registry.global-mount.canary");
    expect((registry as Map<string, unknown>).get("test.registry.global-mount.canary")).toBe(
      canary,
    );
  });

  it("re-importing `key.js` reuses the same registry instance", async () => {
    vi.resetModules();
    await import("#context/key.js");
    const registryKey = Symbol.for("eve.context-key-registry");
    const firstRef = (globalThis as Record<symbol, unknown>)[registryKey];
    expect(firstRef).toBeInstanceOf(Map);

    vi.resetModules();
    await import("#context/key.js");
    const secondRef = (globalThis as Record<symbol, unknown>)[registryKey];

    expect(secondRef).toBe(firstRef);
  });
});
