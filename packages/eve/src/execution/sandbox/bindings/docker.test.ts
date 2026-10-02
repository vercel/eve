import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxProvider } from "#execution/sandbox/bindings/docker.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";

describe("Docker sandbox deletion", () => {
  it("stops and removes the session container", async () => {
    const run: DockerCli["run"] = vi.fn(async (args: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout:
        args[0] === "container" && args[3] === "{{.State.Running}}"
          ? "true\n"
          : args[0] === "container" && args[3] === "{{.Id}}"
            ? "container-id-1\n"
            : "",
      stdoutBytes: Buffer.alloc(0),
    }));
    const dockerCli: DockerCli = {
      run,
      stream() {
        throw new Error("stream is not used by this test");
      },
    };
    const provider = createSandboxProviderHarness(
      createDockerSandboxProvider(undefined, dockerCli),
      {},
      { preparedArtifact: () => ({ imageReference: "prepared-image" }) },
    );
    const handle = await provider.openSession({
      appRoot: "/tmp/eve-app",
      sandboxName: "session-key",
    });
    vi.mocked(run).mockClear();

    await handle.onSessionDelete();

    expect(run).toHaveBeenNthCalledWith(1, ["stop", "-t", "0", "container-id-1"]);
    expect(run).toHaveBeenNthCalledWith(2, ["rm", "-f", "container-id-1"]);
  });

  it("keeps an old handle bound to the deleted container identity", async () => {
    let containerId = "container-id-1";
    const run: DockerCli["run"] = vi.fn(async (args: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout:
        args[0] === "container" && args[3] === "{{.State.Running}}"
          ? "true\n"
          : args[0] === "container" && args[3] === "{{.Id}}"
            ? `${containerId}\n`
            : "",
      stdoutBytes: Buffer.alloc(0),
    }));
    const dockerCli: DockerCli = {
      run,
      stream() {
        throw new Error("stream is not used by this test");
      },
    };
    const provider = createSandboxProviderHarness(
      createDockerSandboxProvider(undefined, dockerCli),
      {},
      { preparedArtifact: () => ({ imageReference: "prepared-image" }) },
    );
    const oldHandle = await provider.openSession({
      appRoot: "/tmp/eve-app",
      sandboxName: "session-key",
    });
    await oldHandle.onSessionDelete();
    containerId = "container-id-2";
    await provider.openSession({
      appRoot: "/tmp/eve-app",
      sandboxName: "session-key",
    });
    vi.mocked(run).mockClear();

    await oldHandle.sandbox.writeTextFile({ content: "stale", path: "/workspace/stale.txt" });

    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining(["container-id-1"]),
      expect.objectContaining({ stdin: expect.any(Uint8Array) }),
    );
    expect(run).not.toHaveBeenCalledWith(
      expect.arrayContaining(["container-id-2"]),
      expect.anything(),
    );
  });
});
