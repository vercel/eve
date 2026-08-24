import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const buildApplicationFromResolvedRootMock = vi.fn();
const compileEmbeddedAgentMock = vi.fn();

vi.mock("#internal/nitro/host/build-application.js", () => ({
  buildApplicationFromResolvedRoot: buildApplicationFromResolvedRootMock,
}));

vi.mock("./compile.js", () => ({
  compileEmbeddedAgent: compileEmbeddedAgentMock,
}));

describe("buildEmbeddedApplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the resolved app root and forwards workspace artifact locations", async () => {
    const appRoot = resolve("embedded-app");
    const artifactLocations = {
      publishedRoot: resolve("embedded-app/.output/.eve"),
      writeRoot: resolve("embedded-app/.eve/builds/test/compiler/.eve"),
    };
    const compileResult = { manifest: {} };

    compileEmbeddedAgentMock.mockResolvedValueOnce(compileResult);
    buildApplicationFromResolvedRootMock.mockImplementationOnce(
      async (
        _appRoot: string,
        _options: unknown,
        compile: (input: { artifactLocations: typeof artifactLocations }) => Promise<unknown>,
      ) => {
        await expect(compile({ artifactLocations })).resolves.toBe(compileResult);
        return resolve("embedded-app/.output");
      },
    );

    const { buildEmbeddedApplication } = await import("./build.js");
    await expect(
      buildEmbeddedApplication({
        appRoot: "embedded-app",
        entrypoint: "embedded-agent.mjs",
        skipVercelSandboxPrewarm: true,
      }),
    ).resolves.toEqual({ outputDirectory: resolve("embedded-app/.output") });

    expect(buildApplicationFromResolvedRootMock).toHaveBeenCalledWith(
      appRoot,
      { skipVercelSandboxPrewarm: true },
      expect.any(Function),
    );
    expect(compileEmbeddedAgentMock).toHaveBeenCalledWith({
      appRoot,
      artifactLocations,
      entrypoint: "embedded-agent.mjs",
    });
  });
});
