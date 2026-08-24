import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { installBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Installs an empty compiled-artifact snapshot on the currently active runtime
 * session. Callers are expected to drive this inside a `withRuntimeSession`
 * scope so the install targets the scoped session rather than the
 * process-default singleton.
 */
async function installEmptyBundledArtifacts(): Promise<void> {
  installBundledCompiledArtifacts(await compileFromMemory({ model: "openai/gpt-5.4-mini" }));
}

/**
 * Runs `fn` inside a freshly-created, test-scoped `RuntimeSession`.
 *
 * Each test body gets its own session so installed compiled artifacts do
 * not leak across test boundaries or to the process-default session. This
 * replaces the earlier pattern of mutating the singleton via
 * `installBundledCompiledArtifacts` + `resetBundledCompiledArtifacts()` in
 * an `afterEach` hook, which guard rule 19 discourages: runtime state
 * should be scoped through `AlsContext` / `RuntimeSession`, not global.
 */
async function withScopedRuntimeSession<T>(fn: () => T | Promise<T>): Promise<T> {
  return await withRuntimeSession(createRuntimeSession("runtime-artifacts-test"), fn);
}

describe("resolveNitroCompiledArtifactsSource", () => {
  it("prefers disk artifacts in development mode even when bundled artifacts exist", async () => {
    await withScopedRuntimeSession(async () => {
      await installEmptyBundledArtifacts();
      const moduleMapLoaderPath = "/package/src/internal/authored-module-map-loader.ts";

      expect(
        resolveNitroCompiledArtifactsSource({
          appRoot: "/tmp/dev-app",
          devRuntimeArtifactsPointerPath: "/tmp/dev-app/.eve/dev-runtime/current.json",
          kind: "development",
          moduleMapLoaderPath,
        }),
      ).toMatchObject({
        appRoot: "/tmp/dev-app",
        kind: "disk",
        moduleMapLoaderPath,
        sandboxAppRoot: "/tmp/dev-app",
      });
    });
  });

  it("uses bundled artifacts outside development mode when they exist", async () => {
    await withScopedRuntimeSession(async () => {
      await installEmptyBundledArtifacts();

      expect(
        resolveNitroCompiledArtifactsSource({
          kind: "production",
        }),
      ).toEqual({
        kind: "bundled",
      });
    });
  });

  it("does not fall back to the authored build path in production", async () => {
    await withScopedRuntimeSession(() => {
      const productionConfig = {
        appRoot: "/tmp/build-machine-app",
        kind: "production" as const,
      };
      expect(() => resolveNitroCompiledArtifactsSource(productionConfig)).toThrow(
        "requires bundled artifacts",
      );
    });
  });
});
