import { describe, expect, it, vi } from "vitest";

import { DockerUnavailableError } from "#execution/sandbox/bindings/docker-cli.js";
import { createDockerSandboxHarness } from "#internal/testing/docker-sandbox-runtime.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("docker CLI resolution", () => {
  it("fails with an actionable error when the docker executable is missing", async () => {
    vi.stubEnv("EVE_DOCKER_PATH", "/nonexistent/docker-binary");
    try {
      const appRoot = await createScratchDirectory("eve-docker-missing-");
      const engine = createDockerSandboxHarness();

      await expect(engine.prepare({ appRoot })).rejects.toThrow(DockerUnavailableError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
