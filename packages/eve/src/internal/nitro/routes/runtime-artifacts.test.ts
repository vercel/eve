import { describe, expect, it } from "vitest";

import { COMPILED_AGENT_MANIFEST_VERSION } from "#compiler/manifest.js";
import { installBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Installs an empty compiled-artifact snapshot on the currently active runtime
 * session. Callers are expected to drive this inside a `withRuntimeSession`
 * scope so the install targets the scoped session rather than the
 * process-default singleton.
 */
function installEmptyBundledArtifacts(): void {
  const manifest = {
    agentId: "test-agent",
    agentRoot: "/tmp/agent",
    appRoot: "/tmp/app",
    channels: [],
    config: {
      model: {
        id: "openai/gpt-5.4-mini",
      },
      name: "Test Agent",
    },
    diagnosticsSummary: {
      errors: 0,
      warnings: 0,
    },
    disabledFrameworkTools: [],
    kind: "eve-agent-compiled-manifest",
    sandbox: null,
    schedules: [],
    skills: [],
    subagentEdges: [],
    subagents: [],
    tools: [],
    version: COMPILED_AGENT_MANIFEST_VERSION,
  };

  installBundledCompiledArtifacts({
    manifest: manifest as unknown as Parameters<
      typeof installBundledCompiledArtifacts
    >[0]["manifest"],
    moduleMap: {
      nodes: {},
    },
  });
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
    await withScopedRuntimeSession(() => {
      installEmptyBundledArtifacts();
      const moduleMapLoaderPath = "/package/src/internal/authored-module-map-loader.ts";

      expect(
        resolveNitroCompiledArtifactsSource({
          appRoot: "/tmp/dev-app",
          dev: true,
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

  it("requires the authored-source loader path in development mode", async () => {
    await withScopedRuntimeSession(() => {
      expect(() =>
        resolveNitroCompiledArtifactsSource({
          appRoot: "/tmp/dev-app",
          dev: true,
        }),
      ).toThrow('require "moduleMapLoaderPath"');
    });
  });

  it("uses bundled artifacts outside development mode when they exist", async () => {
    await withScopedRuntimeSession(() => {
      installEmptyBundledArtifacts();

      expect(
        resolveNitroCompiledArtifactsSource({
          appRoot: "/tmp/prod-app",
          dev: false,
        }),
      ).toEqual({
        kind: "bundled",
      });
    });
  });
});
