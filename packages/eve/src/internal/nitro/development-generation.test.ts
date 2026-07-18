import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopmentGeneration } from "#internal/nitro/development-generation.js";

const mocks = vi.hoisted(() => ({
  activateTransaction: vi.fn(),
  prune: vi.fn(async () => undefined),
}));

vi.mock("#internal/nitro/dev-runtime-artifacts.js", () => ({
  activateDevelopmentRuntimeArtifactsSnapshotTransaction: mocks.activateTransaction,
  pruneDevelopmentRuntimeArtifactsSnapshots: mocks.prune,
  stageDevelopmentRuntimeArtifactsSnapshot: vi.fn(),
}));

const { activateDevelopmentGeneration, activateDevelopmentGenerationTransaction } =
  await import("#internal/nitro/development-generation.js");

function createGeneration(id: string): DevelopmentGeneration {
  return {
    fingerprint: id,
    runtimeAppRoot: `/tmp/${id}/source/app`,
    snapshotRoot: `/tmp/${id}`,
    snapshotSourceRoot: `/tmp/${id}/source`,
    sourceRoot: "/tmp/app",
  };
}

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
