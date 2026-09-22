import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopmentGeneration } from "#internal/nitro/development-generation.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";

const mocks = vi.hoisted(() => ({
  activateTransaction: vi.fn(),
  prune: vi.fn(async () => undefined),
  prepare: vi.fn(),
  stage: vi.fn(),
  materialize: vi.fn(),
  rm: vi.fn(async () => undefined),
}));

vi.mock("node:fs/promises", () => ({ rm: mocks.rm }));
vi.mock("#internal/authored-runtime-modules.js", () => ({
  prepareAuthoredRuntimeModules: mocks.prepare,
}));
vi.mock("#internal/materialized-authored-modules.js", () => ({
  writeMaterializedAuthoredModules: mocks.materialize,
}));

vi.mock("#internal/nitro/dev-runtime-artifacts.js", () => ({
  activateDevelopmentRuntimeArtifactsSnapshotTransaction: mocks.activateTransaction,
  pruneDevelopmentRuntimeArtifactsSnapshots: mocks.prune,
  stageDevelopmentRuntimeArtifactsSnapshot: mocks.stage,
}));

const {
  activateDevelopmentGeneration,
  activateDevelopmentGenerationTransaction,
  stageDevelopmentGeneration,
} = await import("#internal/nitro/development-generation.js");

function createGeneration(id: string): DevelopmentGeneration {
  return {
    fingerprint: id,
    runtimeAppRoot: `/tmp/${id}/source/app`,
    snapshotRoot: `/tmp/${id}`,
    snapshotSourceRoot: `/tmp/${id}/source`,
    sourceRoot: "/tmp/app",
  };
}

describe("development generation staging", () => {
  const compileResult = {
    manifest: {},
    paths: { moduleMapPath: "/tmp/app/modules.mjs" },
    project: { appRoot: "/tmp/app" },
  } as CompileAgentResult;
  beforeEach(() => {
    mocks.prepare.mockReset();
    mocks.stage.mockReset();
    mocks.materialize.mockReset();
    mocks.rm.mockClear();
  });

  it("overlaps preparation with staging and materializes only after both finish", async () => {
    const preparation = Promise.withResolvers<object>();
    const staging = Promise.withResolvers<DevelopmentGeneration>();
    mocks.prepare.mockReturnValue(preparation.promise);
    mocks.stage.mockReturnValue(staging.promise);
    mocks.materialize.mockResolvedValue({ fingerprint: "ready" });
    const result = stageDevelopmentGeneration(compileResult);
    expect(mocks.prepare).toHaveBeenCalledWith({
      appRoot: "/tmp/app",
      manifest: compileResult.manifest,
      moduleMapPath: "/tmp/app/modules.mjs",
    });
    expect(mocks.stage).toHaveBeenCalledOnce();
    preparation.resolve({ authoredWorkflowModules: {} });
    await Promise.resolve();
    expect(mocks.materialize).not.toHaveBeenCalled();
    staging.resolve(createGeneration("parallel"));
    expect(await result).toMatchObject({ fingerprint: "ready" });
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("waits for staging before cleaning up a rejected preparation", async () => {
    const staging = Promise.withResolvers<DevelopmentGeneration>();
    const error = new Error("bundle failed");
    mocks.prepare.mockRejectedValue(error);
    mocks.stage.mockReturnValue(staging.promise);
    const result = stageDevelopmentGeneration(compileResult);
    const observed = result.catch((failure) => failure);
    await Promise.resolve();
    expect(mocks.rm).not.toHaveBeenCalled();
    staging.resolve(createGeneration("discard"));
    expect(await observed).toBe(error);
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/discard", { force: true, recursive: true });
  });

  it("retains both failures when parallel operations reject", async () => {
    const errors = [new Error("prepare"), new Error("stage")];
    mocks.prepare.mockRejectedValue(errors[0]);
    mocks.stage.mockRejectedValue(errors[1]);
    const error = await stageDevelopmentGeneration(compileResult).catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual(errors);
    expect(mocks.rm).not.toHaveBeenCalled();
  });
});

describe("development generation activation", () => {
  beforeEach(() => {
    mocks.activateTransaction.mockReset();
    mocks.prune.mockClear();
  });

  it("requests background storage pruning only after activation commits", async () => {
    const commit = vi.fn();
    const rollback = vi.fn(async () => undefined);
    mocks.activateTransaction.mockResolvedValue({ commit, rollback });

    await activateDevelopmentGeneration({
      appRoot: "/tmp/app-commit",
      generation: createGeneration("committed"),
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(mocks.prune).toHaveBeenCalledWith({ appRoot: "/tmp/app-commit" });
  });

  it("does not request pruning when an activation rolls back", async () => {
    const commit = vi.fn();
    const rollback = vi.fn(async () => undefined);
    mocks.activateTransaction.mockResolvedValue({ commit, rollback });

    const activation = await activateDevelopmentGenerationTransaction({
      appRoot: "/tmp/app-rollback",
      generation: createGeneration("rolled-back"),
    });
    await activation.rollback();
    activation.commit();

    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(mocks.prune).not.toHaveBeenCalled();
  });
});
