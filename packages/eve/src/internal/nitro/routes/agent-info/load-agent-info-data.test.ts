import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBundledCompiledArtifacts: vi.fn(() => null),
  readDevelopmentRuntimeArtifactsSnapshotRoot: vi.fn(
    () => "/tmp/app/.eve/dev-runtime/snapshot/app",
  ),
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
  it("uses dev runtime snapshot artifacts without the authored-source module loader", async () => {
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
      moduleMapLoaderPath: "/tmp/eve/src/internal/authored-module-map-loader.ts",
      sandboxAppRoot: "/tmp/app",
    });
    expect(mocks.readDevelopmentRuntimeArtifactsSnapshotRoot).toHaveBeenCalledWith(
      "/tmp/app/.eve/dev-runtime/current.json",
    );
  });
});
