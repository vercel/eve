import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxHarness } from "#internal/testing/docker-sandbox-runtime.js";
import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";

function createContainerStoreCli() {
  let exists = false;
  let running = false;
  const run: DockerCli["run"] = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "run" || args[0] === "start") running = true;
    if (args[0] === "stop") running = false;
    if (args[0] === "rm") {
      const gone = !exists;
      exists = false;
      return {
        exitCode: gone ? 1 : 0,
        stderr: gone ? "Error response from daemon: No such container: eve-sbx" : "",
        stdout: "",
        stdoutBytes: Buffer.alloc(0),
      };
    }
    if (args[0] === "run") exists = true;
    if ((args[0] === "container" || args[0] === "stop") && !exists) {
      return {
        exitCode: 1,
        stderr: "Error: No such container: eve-sbx",
        stdout: "",
        stdoutBytes: Buffer.alloc(0),
      };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout:
        args[0] === "container" && args[3] === "{{.State.Running}}"
          ? `${running}\n`
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
  return { dockerCli, run };
}

describe("Docker sandbox deletion", () => {
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
    const provider = createDockerSandboxHarness({
      cli: dockerCli,
      preparedArtifact: () => ({ imageReference: "prepared-image" }),
      runtimeOptions: {},
    });
    const session = { appRoot: "/tmp/eve-app", sandboxName: "session-key" };
    const oldHandle = await provider.start(session);
    await provider.endSession({ ...session, reason: "deleted", state: oldHandle.state });
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

  it("deletes the session container by name with the caller's signal, even when it is already gone", async () => {
    const { dockerCli, run } = createContainerStoreCli();
    const provider = createDockerSandboxHarness({
      cli: dockerCli,
      preparedArtifact: () => ({ imageReference: "image-a" }),
      runtimeOptions: {},
    });
    const session = { appRoot: "/tmp/eve-app", sandboxName: "session-key" };
    const { state } = await provider.start(session);
    const signal = new AbortController().signal;

    vi.mocked(run).mockClear();
    await provider.endSession({ ...session, signal, reason: "deleted", state });
    await provider.endSession({ ...session, signal, reason: "deleted", state });
    expect(vi.mocked(run).mock.calls.filter(([args]) => args[0] === "rm")).toEqual([
      [["rm", "-f", state.containerName], { signal }],
      [["rm", "-f", state.containerName], { signal }],
    ]);
  });
});

describe("Docker sandbox session identity", () => {
  it("names the container from the session key alone and removes it by key at session end", async () => {
    const { dockerCli, run } = createContainerStoreCli();
    const provider = createDockerSandboxHarness({
      cli: dockerCli,
      preparedArtifact: () => ({ imageReference: "image-a" }),
      runtimeOptions: {},
    });
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
    expect(vi.mocked(run).mock.calls.map(([args]) => args)).toEqual([
      ["rm", "-f", state.containerName],
    ]);
  });
});

describe("Docker sandbox idle stop", () => {
  it("stops the session container by name without starting it, and succeeds once it is gone", async () => {
    const { dockerCli, run } = createContainerStoreCli();
    const provider = createDockerSandboxHarness({
      cli: dockerCli,
      preparedArtifact: () => ({ imageReference: "image-a" }),
      runtimeOptions: {},
    });
    const session = { appRoot: "/tmp/eve-app", sandboxName: "session-key" };
    const { state } = await provider.start(session);

    vi.mocked(run).mockClear();
    const { signal } = new AbortController();
    await provider.idleSession({ ...session, signal, state });
    expect(vi.mocked(run).mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal }));
    await provider.idleSession({ ...session, state: null });
    await provider.endSession({ ...session, state });
    await expect(provider.idleSession({ ...session, state: null })).resolves.toBeUndefined();

    expect(vi.mocked(run).mock.calls.map(([args]) => args)).toEqual([
      ["stop", "-t", "0", state.containerName],
      ["stop", "-t", "0", state.containerName],
      ["rm", "-f", state.containerName],
      ["stop", "-t", "0", state.containerName],
    ]);
  });

  it("leaves a running container alone while eve reports it in use, stops it once it is not, and asks only about a running one", async () => {
    const { dockerCli, run } = createContainerStoreCli();
    const provider = createDockerSandboxHarness({
      cli: dockerCli,
      preparedArtifact: () => ({ imageReference: "image-a" }),
      runtimeOptions: {},
    });
    const session = { appRoot: "/tmp/eve-app", sandboxName: "session-key" };
    const { state } = await provider.start(session);
    let commandRunning = true;
    const inUse = vi.fn(async () => commandRunning);
    const commands = () => vi.mocked(run).mock.calls.map(([args]) => args[0]);

    vi.mocked(run).mockClear();
    await provider.idleSession({ ...session, inUse, state });
    expect(inUse).toHaveBeenCalledOnce();
    expect(commands()).not.toContain("stop");
    expect(commands()).not.toContain("start");

    commandRunning = false;
    await provider.idleSession({ ...session, inUse, state });
    expect(vi.mocked(run).mock.calls.at(-1)?.[0]).toEqual(["stop", "-t", "0", state.containerName]);

    await provider.idleSession({ ...session, inUse, state });
    expect(inUse).toHaveBeenCalledTimes(2);
  });
});

describe("Docker sandbox network policy", () => {
  it("rejects a domain allow-list at open before creating a container", async () => {
    const run = vi.fn<DockerCli["run"]>();
    const provider = createDockerSandboxHarness({
      cli: {
        run,
        stream() {
          throw new Error("stream is not used by this test");
        },
      },
      preparedArtifact: () => ({ imageReference: "image-a" }),
      runtimeOptions: {},
    });

    await expect(
      provider.start({
        appRoot: "/tmp/eve-app",
        options: { networkPolicy: { allow: ["example.com"] } } as never,
        sandboxName: "session-key",
      }),
    ).rejects.toThrow(/supports only the "allow-all" and "deny-all"/);
    expect(run).not.toHaveBeenCalled();
  });
});
