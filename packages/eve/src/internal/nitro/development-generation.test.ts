import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopmentGeneration } from "#internal/nitro/development-generation.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";

const mocks = vi.hoisted(() => ({
  activateTransaction: vi.fn(),
  prune: vi.fn(async (): Promise<boolean> => false),
  prepare: vi.fn(),
  stage: vi.fn(),
  materialize: vi.fn(),
  rm: vi.fn(async () => undefined),
}));

vi.mock("node:fs/promises", () => ({ rm: mocks.rm }));
vi.mock("#internal/nitro/dev-runtime-generation-metadata.js", () => ({
  finalizeDevelopmentGenerationMetadata: vi.fn(async () => undefined),
}));
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
    mocks.prune.mockReset();
    mocks.prune.mockResolvedValue(false);
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

  it("skips reconciliation after a no-op prune", async () => {
    mocks.activateTransaction.mockResolvedValue({ commit: vi.fn(), rollback: vi.fn() });
    const pruning = Promise.withResolvers<boolean>();
    mocks.prune.mockReturnValueOnce(pruning.promise);
    const onRuntimePruned = vi.fn(async () => undefined);
    await activateDevelopmentGeneration({
      appRoot: "/tmp/app-no-op-prune",
      generation: createGeneration("retained"),
      onRuntimePruned,
    });
    pruning.resolve(false);
    await pruning.promise;
    expect(onRuntimePruned).not.toHaveBeenCalled();
  });

  it("retries failed reconciliation on a later activation even when pruning is a no-op", async () => {
    mocks.activateTransaction.mockResolvedValue({ commit: vi.fn(), rollback: vi.fn() });
    const pruning = Promise.withResolvers<boolean>();
    const reconciliation = Promise.withResolvers<void>();
    mocks.prune.mockReturnValueOnce(pruning.promise);
    const onRuntimePruned = vi
      .fn()
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValue(undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      appRoot: "/tmp/app-reconcile",
      generation: createGeneration("one"),
      onRuntimePruned,
    };
    try {
      await activateDevelopmentGeneration(input);
      expect(onRuntimePruned).not.toHaveBeenCalled();
      pruning.resolve(true);
      await vi.waitFor(() => expect(onRuntimePruned).toHaveBeenCalledOnce());
      reconciliation.reject(new Error("storage unavailable"));
      await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
      await activateDevelopmentGeneration({ ...input, generation: createGeneration("two") });
      await vi.waitFor(() => expect(onRuntimePruned).toHaveBeenCalledTimes(2));
      expect(mocks.prune).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "[eve:dev] failed to reconcile expired Workflow runs: Error: storage unavailable",
      );
    } finally {
      pruning.resolve(false);
      reconciliation.resolve();
      warning.mockRestore();
    }
  });

  it("does not reconcile failed pruning and retries a pending prune request", async () => {
    mocks.activateTransaction.mockResolvedValue({ commit: vi.fn(), rollback: vi.fn() });
    const pruning = Promise.withResolvers<boolean>();
    mocks.prune.mockReturnValueOnce(pruning.promise).mockResolvedValueOnce(false);
    const onRuntimePruned = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      appRoot: "/tmp/app-prune-failure",
      generation: createGeneration("one"),
      onRuntimePruned,
    };
    try {
      await activateDevelopmentGeneration(input);
      await activateDevelopmentGeneration(input);
      pruning.reject(new Error("filesystem unavailable"));
      await vi.waitFor(() => expect(onRuntimePruned).toHaveBeenCalledOnce());
      expect(mocks.prune).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "[eve:dev] failed to prune runtime generations: Error: filesystem unavailable",
      );
    } finally {
      pruning.resolve(false);
      warning.mockRestore();
    }
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
