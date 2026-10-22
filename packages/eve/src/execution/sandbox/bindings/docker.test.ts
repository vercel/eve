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

    await handle.onSandboxDelete();

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
    await oldHandle.onSandboxDelete();
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

describe("Docker sandbox session identity", () => {
  it("names the container from the session key alone and removes it by key at session end", async () => {
    let removed = false;
    const run: DockerCli["run"] = vi.fn(async (args: readonly string[]) => {
      const gone = args[0] === "rm" && removed;
      if (args[0] === "rm") removed = true;
      return {
        exitCode: gone ? 1 : 0,
        stderr: gone ? "Error response from daemon: No such container: eve-sbx" : "",
        stdout:
          args[0] === "container" && args[3] === "{{.State.Running}}"
            ? "true\n"
            : args[0] === "container" && args[3] === "{{.Id}}"
              ? "container-id-1\n"
              : "",
        stdoutBytes: Buffer.alloc(0),
      };
    });
    const dockerCli: DockerCli = {
      run,
      stream() {
        throw new Error("stream is not used by this test");
      },
    };
    const provider = createSandboxProviderHarness(
      createDockerSandboxProvider(undefined, dockerCli),
      {},
      { preparedArtifact: () => ({ imageReference: "image-a" }) },
    );
    const session = { appRoot: "/tmp/eve-app", sandboxName: "session-key" };

    const { state } = await provider.start(session);
    const later = await provider.start({
      ...session,
      options: { networkPolicy: "deny-all" },
      prepared: { imageReference: "image-b" },
    });
    expect(later.state).toEqual(state);

    vi.mocked(run).mockClear();
    await provider.endSession({ ...session, state: null });
    await provider.endSession({ ...session, state: null });
    expect(vi.mocked(run).mock.calls.map(([args]) => args)).toEqual([
      ["rm", "-f", state.containerName],
      ["rm", "-f", state.containerName],
    ]);
  });
});

describe("Docker sandbox network policy", () => {
  it("rejects a domain allow-list at open before creating a container", async () => {
    const run = vi.fn<DockerCli["run"]>();
    const provider = createSandboxProviderHarness(
      createDockerSandboxProvider(undefined, {
        run,
        stream() {
          throw new Error("stream is not used by this test");
        },
      }),
      {},
      { preparedArtifact: () => ({ imageReference: "image-a" }) },
    );

    await expect(
      provider.start({
        appRoot: "/tmp/eve-app",
        // DefaultSandbox forwards the shared network policy type unchanged.
        options: { networkPolicy: { allow: ["example.com"] } } as never,
        sandboxName: "session-key",
      }),
    ).rejects.toThrow(/supports only the "allow-all" and "deny-all"/);
    expect(run).not.toHaveBeenCalled();
  });
});
