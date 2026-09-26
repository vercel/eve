import { describe, expect, it, vi } from "vitest";

import { DockerUnavailableError } from "#execution/sandbox/bindings/docker-cli.js";
import { createDockerSandboxProvider } from "#execution/sandbox/bindings/docker.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("docker CLI resolution", () => {
  it("fails with an actionable error when the docker executable is missing", async () => {
    vi.stubEnv("EVE_DOCKER_PATH", "/nonexistent/docker-binary");
    try {
      const appRoot = await createScratchDirectory("eve-docker-missing-");
      const engine = createSandboxProviderHarness(createDockerSandboxProvider(), undefined);

      await expect(engine.prepare({ appRoot, seedFiles: [] })).rejects.toThrow(
        DockerUnavailableError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
