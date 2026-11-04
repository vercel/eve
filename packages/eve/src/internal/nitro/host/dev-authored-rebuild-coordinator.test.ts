import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import {
  createDevelopmentAuthoredRebuildCoordinator,
  DevelopmentWorkflowWorldChangeRequiresRestartError,
  PostCommitDevelopmentRebuildError,
} from "#internal/nitro/host/dev-authored-rebuild-coordinator.js";
import { createDevelopmentBuilds } from "#internal/nitro/host/dev-build-host.js";
import type { DevHostSwitch } from "#internal/nitro/host/dev-host-supervisor.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

const mocks = vi.hoisted(() => ({
  activateDevelopmentGeneration: vi.fn(async () => undefined),
  buildDevelopmentHostCandidate: vi.fn(async () => ({
    entry: "/tmp/eve-test/entry.mjs",
    workerData: {},
  })),
  computeDevelopmentHostFingerprint: vi.fn(async () => "host-1"),
  createDevelopmentGenerationPruner: vi.fn(),
  createHostNitro: vi.fn(async () => ({})),
  discardDevelopmentGeneration: vi.fn(async () => undefined),
  environmentCommit: vi.fn(),
  environmentRollback: vi.fn(),
  prepareDevelopmentApplicationHost: vi.fn(),
  removeDevelopmentHostWorkspace: vi.fn(async () => undefined),
  requestPrune: vi.fn(),
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
vi.mock("#internal/nitro/host/create-host-nitro.js", () => ({
  createHostNitro: mocks.createHostNitro,
}));
vi.mock("#internal/nitro/host/host-spec.js", () => ({ createHostSpec: () => ({}) }));
vi.mock("#internal/nitro/host/dev-host-candidate.js", () => ({
  buildDevelopmentHostCandidate: mocks.buildDevelopmentHostCandidate,
}));
vi.mock("#internal/nitro/host/dev-host-workspace.js", () => ({
  removeDevelopmentHostWorkspace: mocks.removeDevelopmentHostWorkspace,
}));
vi.mock("#internal/nitro/development-generation.js", () => ({
  activateDevelopmentGeneration: mocks.activateDevelopmentGeneration,
  createDevelopmentGenerationPruner: mocks.createDevelopmentGenerationPruner,
  discardDevelopmentGeneration: mocks.discardDevelopmentGeneration,
}));
vi.mock("#internal/nitro/host/artifacts-config.js", () => ({
  createDevelopmentGenerationArtifactsSource: () => ({ kind: "disk" }),
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
    workspaceExtensions: [],
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

function createHostSwitch(swapTo: DevHostSwitch["swapTo"] = async () => undefined) {
  return {
    prepareSpare: vi.fn<DevHostSwitch["prepareSpare"]>(),
    recycle: vi.fn<DevHostSwitch["recycle"]>(async () => undefined),
    swapTo: vi.fn(swapTo),
  };
}

async function createCoordinator(devServer: DevHostSwitch = createHostSwitch()) {
  mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
  return await createDevelopmentAuthoredRebuildCoordinator({
    builds: createDevelopmentBuilds(),
    devServer,
    initialHost: createHost("initial", "run-1"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createDevelopmentGenerationPruner.mockReturnValue({
    close: async () => undefined,
    request: mocks.requestPrune,
  });
});

describe("transactional authored rebuild coordinator", () => {
  it.each(["host-1", "host-2"])(
    "activates the candidate generation with host fingerprint %s",
    async (fingerprint) => {
      const coordinator = await createCoordinator();
      const candidate = createHost("candidate", "run-2");
      mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(candidate);
      mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce(fingerprint);
      await coordinator.rebuild({ changedPaths: [] });
      expect(mocks.activateDevelopmentGeneration).toHaveBeenCalledWith({
        appRoot: candidate.appRoot,
        generation: candidate.generation,
      });
    },
  );

  it("passes changed paths into extension preparation and retains its committed watch plan", async () => {
    const coordinator = await createCoordinator();
    const candidate = createHost("candidate", "run-1");
    const extension = {
      packageRoot: "/tmp/eve-test/packages/crm",
      buildConfigPaths: ["/tmp/eve-test/packages/crm/tsconfig.json"],
      config: {
        sourceRoot: "/tmp/eve-test/packages/crm/extension",
        distRoot: "/tmp/eve-test/packages/crm/dist/extension",
        outDir: "/tmp/eve-test/packages/crm/dist",
        packageName: "@acme/crm",
        runtimeDependencies: ["eve"],
        externalDependencies: [],
        shortName: "crm",
      },
    } as const;
    candidate.workspaceExtensions = [extension];
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(candidate);
    const changedPaths = ["/tmp/eve-test/packages/crm/extension/tools/search.ts"];

    const result = await coordinator.rebuild({ changedPaths });

    expect(mocks.prepareDevelopmentApplicationHost).toHaveBeenCalledWith("/tmp/eve-test", {
      changedPaths,
      previousExtensions: [],
    });
    expect(result.kind).toBe("unchanged");
    expect(result.host.workspaceExtensions).toEqual([extension]);
  });

  it("keeps the live worker when activation fails after the swap and retries on the next rebuild", async () => {
    const coordinator = await createCoordinator();
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
    // Only the coordinator's initial request: a failed activation prunes nothing.
    expect(mocks.requestPrune).toHaveBeenCalledOnce();

    const retryHost = createHost("retry", "run-2");
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(retryHost);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");

    const retried = await coordinator.rebuild({ changedPaths: [] });
    expect(retried.kind).toBe("runtime");
    expect(mocks.activateDevelopmentGeneration).toHaveBeenLastCalledWith({
      appRoot: retryHost.appRoot,
      generation: retryHost.generation,
    });
  });

  it("serves each runtime generation from a fresh worker and prepares the next spare", async () => {
    const devServer = createHostSwitch();
    const coordinator = await createCoordinator(devServer);

    for (const [index, id] of ["second", "third"].entries()) {
      mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(
        createHost(id, `run-${String(index + 2)}`),
      );
      mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
      await expect(coordinator.rebuild({ changedPaths: [] })).resolves.toMatchObject({
        kind: "runtime",
      });
    }

    expect(devServer.swapTo).not.toHaveBeenCalled();
    expect(devServer.recycle).toHaveBeenCalledTimes(2);
    // Activation precedes each recycle, so the retired worker never loads the new generation.
    expect(mocks.activateDevelopmentGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      devServer.recycle.mock.invocationCallOrder[0]!,
    );
    expect(devServer.prepareSpare).toHaveBeenCalledTimes(2);
  });

  it("discards the candidate and keeps prior state when the swap itself fails", async () => {
    const coordinator = await createCoordinator(
      createHostSwitch(async () => {
        throw new Error("candidate never became ready");
      }),
    );

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
  });

  it.each([
    { initialWorld: undefined, nextWorld: "@example/custom-world" },
    { initialWorld: "@example/custom-world", nextWorld: "local" },
  ])(
    "requires a restart when Workflow World ownership changes from $initialWorld to $nextWorld",
    async ({ initialWorld, nextWorld }) => {
      mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
      const coordinator = await createDevelopmentAuthoredRebuildCoordinator({
        builds: createDevelopmentBuilds(),
        devServer: createHostSwitch(),
        initialHost: createHost("initial", "run-1", initialWorld),
      });
      const candidate = createHost("candidate", "run-2", nextWorld);
      mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(candidate);

      await expect(coordinator.rebuild({ changedPaths: [] })).rejects.toBeInstanceOf(
        DevelopmentWorkflowWorldChangeRequiresRestartError,
      );

      expect(mocks.computeDevelopmentHostFingerprint).toHaveBeenCalledOnce();
      expect(mocks.createHostNitro).not.toHaveBeenCalled();
      expect(mocks.buildDevelopmentHostCandidate).not.toHaveBeenCalled();
      expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(candidate.workspace);
      expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(candidate.generation);
      expect(mocks.environmentRollback).toHaveBeenCalledOnce();
      expect(mocks.environmentCommit).not.toHaveBeenCalled();
    },
  );
});
