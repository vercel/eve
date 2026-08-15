import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDevelopmentRuntimeArtifactsRevision: vi.fn(),
}));

vi.mock("#internal/nitro/dev-runtime-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("#internal/nitro/dev-runtime-artifacts.js")>(
    "#internal/nitro/dev-runtime-artifacts.js",
  );
  return {
    ...actual,
    readDevelopmentRuntimeArtifactsRevision: mocks.readDevelopmentRuntimeArtifactsRevision,
  };
});

beforeEach(() => {
  mocks.readDevelopmentRuntimeArtifactsRevision.mockReset();
});

describe("handleDevRuntimeArtifactsRequest", () => {
  it("returns the current dev runtime artifact revision", async () => {
    const { handleDevRuntimeArtifactsRequest } =
      await import("#internal/nitro/routes/dev-runtime-artifacts.js");
    mocks.readDevelopmentRuntimeArtifactsRevision.mockReturnValueOnce({
      revision: "/tmp/app/.eve/dev-runtime/snapshots/current",
    });

    const response = handleDevRuntimeArtifactsRequest({ appRoot: "/tmp/app" });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      revision: "/tmp/app/.eve/dev-runtime/snapshots/current",
    });
    expect(mocks.readDevelopmentRuntimeArtifactsRevision).toHaveBeenCalledWith("/tmp/app");
  });
});
