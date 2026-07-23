import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { createEmbeddedDevelopmentRebuildCoordinator } from "#internal/nitro/host/embedded-development-rebuild-coordinator.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

const mocks = vi.hoisted(() => ({
  activateDevelopmentGeneration: vi.fn(async () => undefined),
  computeDevelopmentHostConfigurationFingerprint: vi.fn(async (_host?: unknown) => "config-1"),
  computeDevelopmentHostFingerprint: vi.fn(async (_host?: unknown) => "host-1"),
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
vi.mock("#internal/nitro/host/dev-host-fingerprint.js", () => ({
  async computeDevelopmentHostFingerprints(host: PreparedDevelopmentApplicationHost) {
    const [configuration, hostFingerprint] = await Promise.all([
      mocks.computeDevelopmentHostConfigurationFingerprint(host),
      mocks.computeDevelopmentHostFingerprint(host),
    ]);
    return { configuration, host: hostFingerprint };
  },
}));
vi.mock("#internal/nitro/host/prepare-application-host.js", () => ({
  prepareDevelopmentApplicationHost: mocks.prepareDevelopmentApplicationHost,
}));
vi.mock("#internal/nitro/host/dev-host-workspace.js", () => ({
  removeDevelopmentHostWorkspace: mocks.removeDevelopmentHostWorkspace,
}));
vi.mock("#internal/nitro/development-generation.js", () => ({
  activateDevelopmentGeneration: mocks.activateDevelopmentGeneration,
  discardDevelopmentGeneration: mocks.discardDevelopmentGeneration,
}));

function createHost(id: string, runtimeFingerprint: string): PreparedDevelopmentApplicationHost {
  return {
    appRoot: "/tmp/eve-test",
    compileResult: Object.assign({} as CompileAgentResult, {
      manifest: { config: {}, subagents: [] },
      project: { agentRoot: "/tmp/eve-test/custom-agent" },
    }),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("embedded development rebuild coordinator", () => {
  it("discards an unchanged candidate while committing its workspace extensions", async () => {
    const initial = createHost("initial", "runtime-1");
    const candidate = createHost("candidate", "runtime-1");
    const candidateExtension = {
      packageRoot: "/tmp/eve-test/packages/crm",
      buildConfigPaths: ["/tmp/eve-test/packages/crm/tsconfig.json"],
      config: {
        sourceRoot: "/tmp/eve-test/packages/crm/extension",
        distRoot: "/tmp/eve-test/packages/crm/dist/extension",
        outDir: "/tmp/eve-test/packages/crm/dist",
        packageName: "@acme/crm",
        runtimeDependencies: ["eve"],
        shortName: "crm",
      },
    } as const;
    candidate.workspaceExtensions = [candidateExtension];
    const restartHost = vi.fn(async () => undefined);
    const stageRouteTopology = vi.fn();
    mocks.computeDevelopmentHostConfigurationFingerprint
      .mockResolvedValueOnce("config-1")
      .mockResolvedValueOnce("config-1");
    mocks.computeDevelopmentHostFingerprint
      .mockResolvedValueOnce("host-1")
      .mockResolvedValueOnce("host-1");
    const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
      initialHost: initial,
      restartHost,
      stageRouteTopology,
    });
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(candidate);

    const result = await coordinator.rebuild({ changedPaths: [] });

    expect(result).toEqual({
      host: {
        ...initial,
        workspaceExtensions: [candidateExtension],
      },
      kind: "unchanged",
    });
    expect(result.host.generation).toBe(initial.generation);
    expect(result.host.compiledArtifacts).toBe(initial.compiledArtifacts);
    expect(result.host.workflowBuildDir).toBe(initial.workflowBuildDir);
    expect(result.host.workspace).toBe(initial.workspace);
    expect(result.host.workspaceExtensions).toBe(candidate.workspaceExtensions);
    expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(candidate.generation);
    expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledOnce();
    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(candidate.workspace);
    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledOnce();
    expect(mocks.environmentCommit).toHaveBeenCalledOnce();
    expect(mocks.environmentRollback).not.toHaveBeenCalled();
    expect(mocks.activateDevelopmentGeneration).not.toHaveBeenCalled();
    expect(restartHost).not.toHaveBeenCalled();
    expect(stageRouteTopology).not.toHaveBeenCalled();
  });

  it("activates runtime-only changes without restarting the framework", async () => {
    const initial = createHost("initial", "runtime-1");
    const next = createHost("next", "runtime-2");
    const restartHost = vi.fn(async () => undefined);
    const stageRouteTopology = vi.fn();
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
    const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
      initialHost: initial,
      restartHost,
      stageRouteTopology,
    });
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(next);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");

    const changedPaths = ["/tmp/eve-test/custom-agent/instructions.md"];
    const result = await coordinator.rebuild({ changedPaths });

    expect(mocks.prepareDevelopmentApplicationHost).toHaveBeenCalledWith(initial.appRoot, {
      agentRoot: initial.compileResult.project.agentRoot,
      changedPaths,
      previousExtensions: initial.workspaceExtensions,
    });
    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(next.workspace);
    expect(mocks.activateDevelopmentGeneration).toHaveBeenCalledWith({
      appRoot: next.appRoot,
      generation: next.generation,
    });
    expect(result).toEqual({
      host: {
        ...next,
        compiledArtifacts: initial.compiledArtifacts,
        workflowBuildDir: initial.workflowBuildDir,
        workspace: initial.workspace,
      },
      kind: "runtime",
    });
    expect(restartHost).not.toHaveBeenCalled();
    expect(stageRouteTopology).not.toHaveBeenCalled();
    expect(mocks.environmentCommit).toHaveBeenCalledOnce();
  });

  it("atomically activates channel topology without restarting the framework", async () => {
    const initial = createHost("initial", "runtime-1");
    const next = createHost("next", "runtime-2");
    const restartHost = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    const stageRouteTopology = vi.fn(async () => ({ commit, rollback }));
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
    const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
      initialHost: initial,
      restartHost,
      stageRouteTopology,
    });
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(next);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");

    const result = await coordinator.rebuild({ changedPaths: [] });

    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(next.workspace);
    expect(mocks.activateDevelopmentGeneration).toHaveBeenCalledWith({
      appRoot: next.appRoot,
      generation: next.generation,
    });
    expect(stageRouteTopology).toHaveBeenCalledWith({
      nextHost: next,
      previousHost: initial,
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(restartHost).not.toHaveBeenCalled();
    expect(result).toEqual({
      host: {
        ...next,
        compiledArtifacts: initial.compiledArtifacts,
        workflowBuildDir: initial.workflowBuildDir,
        workspace: initial.workspace,
      },
      kind: "structural",
    });
  });

  it("restores the previous generation when a staged topology cannot commit", async () => {
    const initial = createHost("initial", "runtime-1");
    const next = createHost("next", "runtime-2");
    const restartHost = vi.fn(async () => undefined);
    const commitError = new Error("route reload failed");
    const commit = vi.fn(async () => {
      throw commitError;
    });
    const rollback = vi.fn(async () => undefined);
    const stageRouteTopology = vi.fn(async () => ({ commit, rollback }));
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
    const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
      initialHost: initial,
      restartHost,
      stageRouteTopology,
    });
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(next);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");

    await expect(coordinator.rebuild({ changedPaths: [] })).rejects.toBe(commitError);

    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(mocks.activateDevelopmentGeneration).toHaveBeenNthCalledWith(1, {
      appRoot: next.appRoot,
      generation: next.generation,
    });
    expect(mocks.activateDevelopmentGeneration).toHaveBeenNthCalledWith(2, {
      appRoot: initial.appRoot,
      generation: initial.generation,
    });
    expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(next.generation);
    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(next.workspace);
    expect(mocks.environmentCommit).not.toHaveBeenCalled();
    expect(mocks.environmentRollback).toHaveBeenCalledOnce();
    expect(restartHost).not.toHaveBeenCalled();
  });

  it("restarts the framework for non-route structural changes", async () => {
    const initial = createHost("initial", "runtime-1");
    const next = createHost("next", "runtime-2");
    const restartHost = vi.fn(async () => undefined);
    const stageRouteTopology = vi.fn();
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
    mocks.computeDevelopmentHostConfigurationFingerprint.mockResolvedValueOnce("config-1");
    const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
      initialHost: initial,
      restartHost,
      stageRouteTopology,
    });
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(next);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");
    mocks.computeDevelopmentHostConfigurationFingerprint.mockResolvedValueOnce("config-2");

    const result = await coordinator.rebuild({ changedPaths: [] });

    expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(next.generation);
    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(next.workspace);
    expect(restartHost).toHaveBeenCalledOnce();
    expect(stageRouteTopology).not.toHaveBeenCalled();
    expect(result).toEqual({ host: initial, kind: "structural" });
  });

  it("rolls back staged environment changes when the framework restart fails", async () => {
    const initial = createHost("initial", "runtime-1");
    const next = createHost("next", "runtime-2");
    const restartError = new Error("replacement was not installed");
    const restartHost = vi.fn(async () => {
      throw restartError;
    });
    const stageRouteTopology = vi.fn();
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
    mocks.computeDevelopmentHostConfigurationFingerprint.mockResolvedValueOnce("config-1");
    const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
      initialHost: initial,
      restartHost,
      stageRouteTopology,
    });
    mocks.prepareDevelopmentApplicationHost.mockResolvedValueOnce(next);
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-2");
    mocks.computeDevelopmentHostConfigurationFingerprint.mockResolvedValueOnce("config-2");

    await expect(coordinator.rebuild({ changedPaths: [] })).rejects.toBe(restartError);

    expect(mocks.discardDevelopmentGeneration).toHaveBeenCalledWith(next.generation);
    expect(mocks.removeDevelopmentHostWorkspace).toHaveBeenCalledWith(next.workspace);
    expect(mocks.environmentCommit).not.toHaveBeenCalled();
    expect(mocks.environmentRollback).toHaveBeenCalledOnce();
  });

  it("keeps the active generation when candidate compilation fails", async () => {
    const initial = createHost("initial", "runtime-1");
    const restartHost = vi.fn(async () => undefined);
    const stageRouteTopology = vi.fn();
    mocks.computeDevelopmentHostFingerprint.mockResolvedValueOnce("host-1");
    const coordinator = await createEmbeddedDevelopmentRebuildCoordinator({
      initialHost: initial,
      restartHost,
      stageRouteTopology,
    });
    mocks.prepareDevelopmentApplicationHost.mockRejectedValueOnce(new Error("compile failed"));

    await expect(coordinator.rebuild({ changedPaths: [] })).rejects.toThrow("compile failed");

    expect(mocks.activateDevelopmentGeneration).not.toHaveBeenCalled();
    expect(restartHost).not.toHaveBeenCalled();
    expect(mocks.environmentRollback).toHaveBeenCalledOnce();
  });
});
