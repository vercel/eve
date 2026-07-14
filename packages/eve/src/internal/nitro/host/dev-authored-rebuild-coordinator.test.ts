import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import {
  createDevelopmentAuthoredRebuildCoordinator,
  DevelopmentWorkflowWorldChangeRequiresRestartError,
  PostCommitDevelopmentRebuildError,
} from "#internal/nitro/host/dev-authored-rebuild-coordinator.js";
import { DrainedNitroDevServer } from "#internal/nitro/host/drained-nitro-dev-server.js";
import type { DevelopmentRunnerFactory } from "#internal/nitro/host/dev-runner.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

const mocks = vi.hoisted(() => ({
  activateDevelopmentGeneration: vi.fn(async () => undefined),
  buildDevelopmentHostCandidate: vi.fn(async () => ({
    entry: "/tmp/eve-test/entry.mjs",
    workerData: {},
  })),
  computeDevelopmentHostFingerprint: vi.fn(async () => "host-1"),
  createDevelopmentApplicationNitro: vi.fn(async () => ({})),
  discardDevelopmentGeneration: vi.fn(async () => undefined),
  environmentCommit: vi.fn(),
  environmentRollback: vi.fn(),
  prepareDevelopmentApplicationHost: vi.fn(),
  removeDevelopmentHostWorkspace: vi.fn(async () => undefined),
}));

vi.mock("#cli/dev/environment.js", () => ({
  stageDevelopmentEnvironmentFiles: () => ({
    commit: mocks.environmentCommit,
    rollback: mocks.environmentRollback,
  }),
}));
vi.mock("#internal/nitro/host/prepare-application-host.js", () => ({
  prepareDevelopmentApplicationHost: mocks.prepareDevelopmentApplicationHost,
}));
vi.mock("#internal/nitro/host/dev-host-fingerprint.js", () => ({
  computeDevelopmentHostFingerprint: mocks.computeDevelopmentHostFingerprint,
}));
vi.mock("#internal/nitro/host/create-application-nitro.js", () => ({
  createDevelopmentApplicationNitro: mocks.createDevelopmentApplicationNitro,
}));
vi.mock("#internal/nitro/host/dev-host-candidate.js", () => ({
  buildDevelopmentHostCandidate: mocks.buildDevelopmentHostCandidate,
}));
vi.mock("#internal/nitro/host/dev-host-workspace.js", () => ({
  removeDevelopmentHostWorkspace: mocks.removeDevelopmentHostWorkspace,
}));
vi.mock("#internal/nitro/development-generation.js", () => ({
  activateDevelopmentGeneration: mocks.activateDevelopmentGeneration,
  discardDevelopmentGeneration: mocks.discardDevelopmentGeneration,
}));
vi.mock("#internal/nitro/host/artifacts-config.js", () => ({
  createDevelopmentNitroArtifactsConfig: () => ({}),
}));
vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: () => ({}),
}));
vi.mock("#execution/sandbox/development-prewarm.js", () => ({
  startDevelopmentSandboxPrewarmInBackground: vi.fn(),
}));

function createHost(
  id: string,
  runtimeFingerprint: string,
  configuredWorld?: string,
): PreparedDevelopmentApplicationHost {
  return {
    appRoot: "/tmp/eve-test",
    compileResult: {
      manifest: {
        config: {
          experimental: {
            workflow: configuredWorld === undefined ? undefined : { world: configuredWorld },
          },
        },
      },
      project: { agentRoot: "/tmp/eve-test/agent" },
    } as CompileAgentResult,
    compiledArtifacts: {
      bootstrapPath: `/tmp/eve-test/.eve/dev-hosts/${id}/bootstrap.mjs`,
      workflowWorldPluginPath: `/tmp/eve-test/.eve/dev-hosts/${id}/workflow-world.mjs`,
    },
    generation: {
      fingerprint: runtimeFingerprint,
      runtimeAppRoot: `/tmp/eve-test/.eve/dev-runtime/snapshots/${id}/source/app`,
      snapshotRoot: `/tmp/eve-test/.eve/dev-runtime/snapshots/${id}`,
      snapshotSourceRoot: `/tmp/eve-test/.eve/dev-runtime/snapshots/${id}/source`,
      sourceRoot: "/tmp/eve-test",
    },
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: `/tmp/eve-test/.eve/dev-hosts/${id}/workflow`,
    workspace: {
      artifactsDir: `/tmp/eve-test/.eve/dev-hosts/${id}/artifacts`,
      compilerArtifactsDir: `/tmp/eve-test/.eve/dev-hosts/${id}/compiler`,
      nitroBuildDir: `/tmp/eve-test/.eve/dev-hosts/${id}/nitro`,
      nitroOutputDir: `/tmp/eve-test/.eve/dev-hosts/${id}/output`,
      rootDir: `/tmp/eve-test/.eve/dev-hosts/${id}`,
      workflowBuildDir: `/tmp/eve-test/.eve/dev-hosts/${id}/workflow`,
    },
  };
}

const createRunner: DevelopmentRunnerFactory = () => {
  let closed = false;
  const closedListeners = new Set<(cause?: unknown) => void>();
  return {
    close: async () => {
      closed = true;
      for (const listener of [...closedListeners]) {
        listener();
      }
      closedListeners.clear();
    },
    get closed() {
      return closed;
    },
    fetch: async () => new Response("ok"),
    onceClosed(listener) {
      if (closed) {
        listener();
        return;
      }
      closedListeners.add(listener);
    },
    upgrade: async () => undefined,
    waitForReady: async () => undefined,
  };
};

async function createCoordinatorWithServer() {
  const devServer = new DrainedNitroDevServer({ error: () => undefined }, createRunner);
  mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
  const coordinator = await createDevelopmentAuthoredRebuildCoordinator({
    devServer,
    initialHost: createHost("initial", "run-1"),
  });
  return { coordinator, devServer };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transactional authored rebuild coordinator", () => {
  it("keeps the live worker when activation fails after the swap and retries on the next rebuild", async () => {
    const { coordinator, devServer } = await createCoordinatorWithServer();
    const structuralHost = createHost("structural", "run-2");
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(structuralHost);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");
    mocks.activateDevelopmentGeneration.mockRejectedValueOnce(new Error("pointer write failed"));

    await expect(coordinator.rebuild({ changedPaths: [] })).rejects.toBeInstanceOf(
      PostCommitDevelopmentRebuildError,
    );

    // The live worker's workspace survives; only the unactivated generation
    // snapshot is discarded, and the staged environment stays committed.
    expect(mocks.removeDevelopmentHostWorkspace).not.toHaveBeenCalled();
    expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(structuralHost.generation);
    expect(mocks.environmentCommit).toHaveBeenCalledOnce();
    expect(mocks.environmentRollback).not.toHaveBeenCalled();

    const retryHost = createHost("retry", "run-2");
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(retryHost);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");

    const retried = await coordinator.rebuild({ changedPaths: [] });
    expect(retried.kind).toBe("runtime");
    expect(mocks.activateDevelopmentGeneration).toHaveBeenLastCalledWith({
      appRoot: retryHost.appRoot,
      generation: retryHost.generation,
    });
    await devServer.close();
  });

  it("discards the candidate and keeps prior state when the swap itself fails", async () => {
    const failingFactory: DevelopmentRunnerFactory = () => {
      const runner = createRunner({ entry: "/tmp/eve-test/entry.mjs", name: "t", workerData: {} });
      return {
        ...runner,
        waitForReady: async () => {
          throw new Error("candidate never became ready");
        },
      };
    };
    const devServer = new DrainedNitroDevServer({ error: () => undefined }, failingFactory);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
    const coordinator = await createDevelopmentAuthoredRebuildCoordinator({
      devServer,
      initialHost: createHost("initial", "run-1"),
    });

    const structuralHost = createHost("structural", "run-2");
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(structuralHost);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");

    await expect(coordinator.rebuild({ changedPaths: [] })).rejects.toThrow(
      "candidate never became ready",
    );

    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(structuralHost.workspace);
    expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(structuralHost.generation);
    expect(mocks.activateDevelopmentGeneration).not.toHaveBeenCalled();
    expect(mocks.environmentRollback).toHaveBeenCalledOnce();
    expect(mocks.environmentCommit).not.toHaveBeenCalled();
    await devServer.close();
  });

  it.each([
    { initialWorld: undefined, nextWorld: "@example/custom-world" },
    { initialWorld: "@example/custom-world", nextWorld: "local" },
  ])(
    "requires a restart when Workflow World ownership changes from $initialWorld to $nextWorld",
    async ({ initialWorld, nextWorld }) => {
      const devServer = new DrainedNitroDevServer({ error: () => undefined }, createRunner);
      mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
      const coordinator = await createDevelopmentAuthoredRebuildCoordinator({
        devServer,
        initialHost: createHost("initial", "run-1", initialWorld),
      });
      const candidate = createHost("candidate", "run-2", nextWorld);
      mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(candidate);

      await expect(coordinator.rebuild({ changedPaths: [] })).rejects.toBeInstanceOf(
        DevelopmentWorkflowWorldChangeRequiresRestartError,
      );

      expect(mocks.computeDevelopmentHostFingerprint).toHaveBeenCalledOnce();
      expect(mocks.createDevelopmentApplicationNitro).not.toHaveBeenCalled();
      expect(mocks.buildDevelopmentHostCandidate).not.toHaveBeenCalled();
      expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(candidate.workspace);
      expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(candidate.generation);
      expect(mocks.environmentRollback).toHaveBeenCalledOnce();
      expect(mocks.environmentCommit).not.toHaveBeenCalled();

      await devServer.close();
    },
  );
});
