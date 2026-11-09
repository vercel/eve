import { beforeEach, describe, expect, it, vi } from "vitest";

import { stopDevelopmentSandboxResources } from "#execution/sandbox/development-cleanup.js";

const state = vi.hoisted(() => ({
  dockerCli: {
    run: vi.fn(),
  },
}));

vi.mock("#execution/sandbox/bindings/docker-cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#execution/sandbox/bindings/docker-cli.js")>();
  return {
    ...actual,
    createDockerCli: () => state.dockerCli,
  };
});

describe("stopDevelopmentSandboxResources", () => {
  beforeEach(() => {
    state.dockerCli.run.mockReset();
  });

  it("stops Docker containers tagged with the dev run id", async () => {
    state.dockerCli.run.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "ps") {
        return { exitCode: 0, stderr: "", stdout: "docker-container\n" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    await stopDevelopmentSandboxResources({ devRunId: "run-123" });

    expect(state.dockerCli.run).toHaveBeenCalledWith([
      "ps",
      "-q",
      "--filter",
      "label=eve.sandbox=1",
      "--filter",
      "label=eve.sandbox.tag.devRunId=run-123",
    ]);
    expect(state.dockerCli.run).toHaveBeenCalledWith(["stop", "-t", "0", "docker-container"]);
  });

  it("stays quiet when the Docker CLI is unavailable", async () => {
    const { DockerUnavailableError } = await import("#execution/sandbox/bindings/docker-cli.js");
    state.dockerCli.run.mockRejectedValue(new DockerUnavailableError());
    const log = vi.fn();

    await stopDevelopmentSandboxResources({ devRunId: "run-123", log });

    expect(log).not.toHaveBeenCalled();
  });
});
