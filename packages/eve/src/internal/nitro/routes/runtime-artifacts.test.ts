import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { installBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

async function installEmptyBundledArtifacts(): Promise<void> {
  const { manifest, moduleMap } = await compileFromMemory({
    model: "openai/gpt-5.4",
    name: "test-agent",
  });

  installBundledCompiledArtifacts({
    manifest,
    moduleMap,
  });
}

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
          sandboxScope: "test-sandbox-scope",
        }),
      ).toEqual({
        kind: "bundled",
        sandboxScope: "test-sandbox-scope",
      });
    });
  });

  it("does not fall back to the authored build path in production", async () => {
    await withScopedRuntimeSession(() => {
      const productionConfig = {
        kind: "production" as const,
        sandboxScope: "test-sandbox-scope",
      };
      expect(() => resolveNitroCompiledArtifactsSource(productionConfig)).toThrow(
        "requires bundled artifacts",
      );
    });
  });
});
