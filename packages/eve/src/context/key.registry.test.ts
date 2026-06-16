import { describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the `keyRegistry` chunk-isolation failure mode.
 *
 * `eve dev` (Nitro) inlines parts of `eve` into separate workflow
 * chunks. Each chunk gets its own module loader, so any module-scoped state
 * in `key.ts` (the `keyRegistry` Map) ends up as separate instances per chunk.
 * That made `setContext(MyKey, value)` from a hook handler invisible to
 * `getContext(MyKey)` from a sibling channel-event handler one step later:
 * the writer chunk's `serializeContext` -> `ctx.entries()` -> `resolveKey()`
 * silently dropped the entry (writer side), or the reader chunk's
 * `deserializeContext` -> `resolveKey()` silently dropped it (reader side).
 *
 * The fix is to mount `keyRegistry` on `globalThis` under a stable
 * `Symbol.for(...)` so every module copy resolves the same registry,
 * mirroring the established patterns for `contextStorage` (container.ts)
 * and the runtime-session storage (runtime/sessions/runtime-session.ts).
 *
 * These tests reproduce the failure by using `vi.resetModules()` to force
 * a fresh evaluation of `key.ts`, which simulates two separate module loaders
 * holding their own copies of the file.
 */
describe("keyRegistry chunk-isolation (GTMENG-1154 regression)", () => {
  it("a key registered in one module evaluation is resolvable from another", async () => {
    vi.resetModules();
    const moduleA = await import("#context/key.js");
    const alice = new moduleA.ContextKey<string>("test.registry.cross-module.alice");

    vi.resetModules();
    const moduleB = await import("#context/key.js");

    // Pre-fix: moduleB's `keyRegistry` is a fresh Map and returns undefined.
    // Post-fix: both evaluations share one globalThis-mounted Map.
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
