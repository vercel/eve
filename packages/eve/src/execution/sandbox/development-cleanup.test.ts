import { beforeEach, describe, expect, it, vi } from "vitest";

import { stopDevelopmentSandboxResources } from "#execution/sandbox/development-cleanup.js";

const state = vi.hoisted(() => {
  const dockerCli = {
    run: vi.fn(),
  };
  const microsandboxStopWithTimeout = vi.fn(async () => undefined);
  const readSessionMetadata = vi.fn();
  const removeSnapshotIfExists = vi.fn(async () => undefined);
  const stopAndSnapshotMicrosandboxSandbox = vi.fn(async () => undefined);
  const writeSessionMetadata = vi.fn(async () => undefined);
  const microsandboxModule = {
    Sandbox: {
      get: vi.fn(async () => ({ stopWithTimeout: microsandboxStopWithTimeout })),
      listWith: vi.fn(async () => [
        {
          configJson: JSON.stringify({
            labels: { "eve.metadataPath": "/tmp/eve-microsandbox-session/metadata.json" },
          }),
          name: "msb-session",
          status: "running",
        },
        {
          configJson: JSON.stringify({ labels: {} }),
          name: "msb-template",
          status: "running",
        },
      ]),
    },
  };
  return {
    dockerCli,
    loadMicrosandboxWithoutInstall: vi.fn(async () => microsandboxModule),
    microsandboxModule,
    microsandboxStopWithTimeout,
    readSessionMetadata,
    removeSnapshotIfExists,
    stopAndSnapshotMicrosandboxSandbox,
    writeSessionMetadata,
  };
});

vi.mock("#execution/sandbox/bindings/docker-cli.js", () => ({
  createDockerCli: () => state.dockerCli,
}));

vi.mock("#execution/sandbox/bindings/microsandbox-runtime.js", () => ({
  createProviderName: (prefix: string, key: string) => `${prefix}-${key}`,
  loadMicrosandboxWithoutInstall: state.loadMicrosandboxWithoutInstall,
  removeSnapshotIfExists: state.removeSnapshotIfExists,
  stopAndSnapshotMicrosandboxSandbox: state.stopAndSnapshotMicrosandboxSandbox,
}));

vi.mock("#execution/sandbox/bindings/microsandbox-metadata.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#execution/sandbox/bindings/microsandbox-metadata.js")>();
  return {
    ...actual,
    readSessionMetadata: state.readSessionMetadata,
    writeSessionMetadata: state.writeSessionMetadata,
  };
});

describe("stopDevelopmentSandboxResources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.dockerCli.run.mockReset();
  });

  it("stops Docker containers and snapshots microsandbox sessions tagged with the dev run id", async () => {
    state.dockerCli.run.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "ps") {
        return { exitCode: 0, stderr: "", stdout: "docker-container\n" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    state.readSessionMetadata.mockResolvedValue({
      networkPolicy: "allow-all",
      optionsHash: "options-hash",
      sandboxName: "msb-session",
      stateSnapshotName: "old-snapshot",
      version: 2,
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
    expect(state.microsandboxModule.Sandbox.listWith).toHaveBeenCalledWith({
      labels: {
        "eve.backend": "microsandbox",
        devRunId: "run-123",
      },
    });
    expect(state.stopAndSnapshotMicrosandboxSandbox).toHaveBeenCalledWith(
      state.microsandboxModule,
      "msb-session",
      expect.stringMatching(/^eve-sbx-state-msb-session:/u),
    );
    expect(state.writeSessionMetadata).toHaveBeenCalledWith(
      "/tmp/eve-microsandbox-session/metadata.json",
      {
        networkPolicy: "allow-all",
        optionsHash: "options-hash",
        sandboxName: "msb-session",
        stateSnapshotName: expect.stringMatching(/^eve-sbx-state-msb-session:/u),
        version: 2,
      },
    );
    expect(state.removeSnapshotIfExists).toHaveBeenCalledWith(
      state.microsandboxModule,
      "old-snapshot",
    );
    expect(state.microsandboxModule.Sandbox.get).toHaveBeenCalledWith("msb-template");
    expect(state.microsandboxStopWithTimeout).toHaveBeenCalledWith(10_000);
  });

  it("skips every backend when no development sandbox was initialized", async () => {
    await stopDevelopmentSandboxResources({
      backendNames: [],
      devRunId: "run-123",
    });

    expect(state.dockerCli.run).not.toHaveBeenCalled();
    expect(state.loadMicrosandboxWithoutInstall).not.toHaveBeenCalled();
  });

  it("does not probe Docker when only microsandbox was initialized", async () => {
    state.microsandboxModule.Sandbox.listWith.mockResolvedValueOnce([]);

    await stopDevelopmentSandboxResources({
      backendNames: ["microsandbox"],
      devRunId: "run-123",
    });

    expect(state.dockerCli.run).not.toHaveBeenCalled();
    expect(state.microsandboxModule.Sandbox.listWith).toHaveBeenCalledWith({
      labels: {
        "eve.backend": "microsandbox",
        devRunId: "run-123",
      },
    });
  });
});
