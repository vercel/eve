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
        dev: true,
        devRuntimeArtifactsPointerPath: "/tmp/app/.eve/dev-runtime/current.json",
      }),
    ).toEqual({
      appRoot: "/tmp/app/.eve/dev-runtime/snapshot/app",
      kind: "disk",
    });
    expect(mocks.readDevelopmentRuntimeArtifactsSnapshotRoot).toHaveBeenCalledWith(
      "/tmp/app/.eve/dev-runtime/current.json",
    );
  });
});
