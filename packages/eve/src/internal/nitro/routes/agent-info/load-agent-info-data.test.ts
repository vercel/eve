import { describe, expect, it, vi } from "vitest";

import {
  createStubCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

const mocks = vi.hoisted(() => ({
  loadCompiledManifest: vi.fn(),
  readBundledCompiledArtifacts: vi.fn(() => null),
  readDevelopmentRuntimeArtifactsSnapshotRoot: vi.fn(
    () => "/tmp/app/.eve/dev-runtime/snapshot/app",
  ),
}));

vi.mock("#runtime/loaders/manifest.js", () => ({
  loadCompiledManifest: mocks.loadCompiledManifest,
}));

vi.mock("#internal/nitro/dev-runtime-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("#internal/nitro/dev-runtime-artifacts.js")>(
    "#internal/nitro/dev-runtime-artifacts.js",
  );
  return {
    ...actual,
    readDevelopmentRuntimeArtifactsSnapshotRoot: mocks.readDevelopmentRuntimeArtifactsSnapshotRoot,
  };
});

vi.mock("#runtime/loaders/bundled-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("#runtime/loaders/bundled-artifacts.js")>(
    "#runtime/loaders/bundled-artifacts.js",
  );
  return {
    ...actual,
    readBundledCompiledArtifacts: mocks.readBundledCompiledArtifacts,
  };
});

describe("resolveAgentInfoCompiledArtifactsSource", () => {
  it("uses the materialized development runtime snapshot", async () => {
    const { resolveAgentInfoCompiledArtifactsSource } =
      await import("#internal/nitro/routes/agent-info/load-agent-info-data.js");

    expect(
      resolveAgentInfoCompiledArtifactsSource({
        appRoot: "/tmp/app",
        devRuntimeArtifactsPointerPath: "/tmp/app/.eve/dev-runtime/current.json",
        kind: "development",
        moduleMapLoaderPath: "/tmp/eve/src/internal/authored-module-map-loader.ts",
      }),
    ).toEqual({
      appRoot: "/tmp/app/.eve/dev-runtime/snapshot/app",
      kind: "disk",
      moduleMapLoaderKind: "materialized-generation",
      moduleMapLoaderPath: "/tmp/eve/src/internal/authored-module-map-loader.ts",
      sandboxAppRoot: "/tmp/app",
    });
    expect(mocks.readDevelopmentRuntimeArtifactsSnapshotRoot).toHaveBeenCalledWith(
      "/tmp/app/.eve/dev-runtime/current.json",
    );
  });
});

describe("loadAgentInfoManifestData", () => {
  it("returns the exact validated compiled manifest without a second graph projection", async () => {
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "Inspection loader",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
    });
    mocks.loadCompiledManifest.mockResolvedValueOnce(manifest);
    const { loadAgentInfoManifestData } =
      await import("#internal/nitro/routes/agent-info/load-agent-info-data.js");

    await expect(
      loadAgentInfoManifestData({ compiledArtifactsSource: { kind: "bundled" } }),
    ).resolves.toEqual({ manifest });
    expect(mocks.loadCompiledManifest).toHaveBeenCalledWith({
      compiledArtifactsSource: { kind: "bundled" },
    });
  });
});
