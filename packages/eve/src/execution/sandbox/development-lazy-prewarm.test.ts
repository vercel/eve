import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  ensureDevelopmentSandboxesPrepared,
  startDevelopmentSandboxesPrewarm,
} from "./development-lazy-prewarm.js";

const mocks = vi.hoisted(() => ({
  acquireRecoveryLease: vi.fn(),
  loadSandboxPreparedArtifact: vi.fn(),
  prewarmAppSandboxes: vi.fn(),
}));

vi.mock("./prewarm.js", () => ({ prewarmAppSandboxes: mocks.prewarmAppSandboxes }));
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: mocks.loadSandboxPreparedArtifact,
}));
vi.mock("#internal/application/output-publication-lock.js", () => ({
  acquireRecoveryLease: mocks.acquireRecoveryLease,
  startPublicationJournalHeartbeat: () => () => undefined,
}));
vi.mock("#runtime/loaders/artifact-paths.js", () => ({
  resolveRuntimeCompilerArtifactPaths: () => ({ compileDirectoryPath: "/app/.eve/compile" }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(async () => undefined) };
});

const input = {
  compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource("/app"),
  nodeId: "__root__",
  providerName: "test",
};

describe("startDevelopmentSandboxesPrewarm", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.acquireRecoveryLease.mockResolvedValue({ complete: async () => undefined });
    mocks.loadSandboxPreparedArtifact.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts preparation without waiting for an eval that needs a sandbox", async () => {
    let published = false;
    const release = Promise.withResolvers<void>();
    mocks.loadSandboxPreparedArtifact.mockImplementation(async () =>
      published ? { artifact: null } : undefined,
    );
    mocks.prewarmAppSandboxes.mockImplementation(async () => {
      await release.promise;
      published = true;
    });

    expect(startDevelopmentSandboxesPrewarm(input)).toBeUndefined();
    expect(published).toBe(false);

    release.resolve();
    await vi.waitFor(() => expect(published).toBe(true));
    await ensureDevelopmentSandboxesPrepared(input);

    expect(mocks.prewarmAppSandboxes).toHaveBeenCalledTimes(1);
  });

  it("logs a failed preparation and still fails the eval that needs the sandbox", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.prewarmAppSandboxes.mockRejectedValue(new Error("template build failed"));

    startDevelopmentSandboxesPrewarm(input);
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledWith(expect.stringContaining("template build failed"));
    });

    await expect(ensureDevelopmentSandboxesPrepared(input)).rejects.toThrow(
      "template build failed",
    );
    expect(mocks.prewarmAppSandboxes).toHaveBeenCalledTimes(2);
  });
});
