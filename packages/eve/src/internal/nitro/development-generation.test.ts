import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCompilerArtifactPaths } from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";
import type { DevelopmentGeneration } from "#internal/nitro/development-generation.js";

const mocks = vi.hoisted(() => ({
  activateTransaction: vi.fn(),
  prepare: vi.fn(),
  prune: vi.fn(async () => undefined),
  readFile: vi.fn(),
  stage: vi.fn(),
  write: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: mocks.readFile,
}));

vi.mock("#internal/materialized-authored-modules.js", () => ({
  prepareMaterializedAuthoredModules: mocks.prepare,
  writeMaterializedAuthoredModules: mocks.write,
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

describe("development generation activation", () => {
  beforeEach(() => {
    mocks.activateTransaction.mockReset();
    mocks.prepare.mockReset();
    mocks.prune.mockClear();
    mocks.readFile.mockReset();
    mocks.stage.mockReset();
    mocks.write.mockReset();
  });

  it("projects the staged manifest onto the exact copied module-map artifact", async () => {
    const appRoot = "/tmp/app";
    const compiled = await compileFromMemory({ appRoot, model: "openai/gpt-5.4-mini" });
    const generation = createGeneration("captured-module-map");
    const moduleMapSource = "export const moduleMapDescriptor = exact;\n";
    const prepared = { moduleMapCode: "bundled exact descriptor" };
    mocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("compiled-agent-manifest.json")
        ? JSON.stringify(compiled.manifest)
        : moduleMapSource,
    );
    mocks.prepare.mockResolvedValue(prepared);
    mocks.stage.mockResolvedValue(generation);
    mocks.write.mockResolvedValue({ fingerprint: "captured-fingerprint" });

    const compileResult: CompileAgentResult = {
      diagnostics: compiled.diagnostics.diagnostics,
      manifest: compiled.manifest,
      metadata: {
        ...compiled.metadata,
        compile: {
          ...compiled.metadata.compile,
          moduleMap: {
            ...compiled.metadata.compile.moduleMap,
            sha256: createHash("sha256").update(moduleMapSource).digest("hex"),
          },
        },
      },
      paths: resolveCompilerArtifactPaths("/tmp/compiler-workspace"),
      project: { agentRoot: `${appRoot}/agent`, appRoot, layout: "nested" },
    };
    const result = await stageDevelopmentGeneration(compileResult);

    expect(mocks.readFile).toHaveBeenCalledWith(
      "/tmp/captured-module-map/source/app/.eve/compile/module-map.mjs",
      "utf8",
    );
    expect(mocks.readFile).toHaveBeenCalledWith(
      "/tmp/captured-module-map/source/app/.eve/compile/compiled-agent-manifest.json",
      "utf8",
    );
    expect(mocks.prepare).toHaveBeenCalledWith({
      descriptorProjection: {
        manifest: compiled.manifest,
        runtimeAppRoot: generation.runtimeAppRoot,
      },
      expectedIdentity: compiled.metadata.compile.moduleMap.identitySha256,
      manifest: compiled.manifest,
      moduleMapPath: "/tmp/app/.eve/compile/module-map.mjs",
      moduleMapSource,
    });
    expect(mocks.stage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readFile.mock.invocationCallOrder[0]!,
    );
    expect(mocks.write).toHaveBeenCalledWith({
      prepared,
      runtimeAppRoot: generation.runtimeAppRoot,
    });
    expect(result).toEqual({ ...generation, fingerprint: "captured-fingerprint" });
  });

  it("rejects copied module-map bytes that do not match the compiler snapshot", async () => {
    const appRoot = "/tmp/app";
    const compiled = await compileFromMemory({ appRoot, model: "openai/gpt-5.4-mini" });
    const generation = createGeneration("tampered-module-map");
    mocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("compiled-agent-manifest.json")
        ? JSON.stringify(compiled.manifest)
        : "export default 'tampered';\n",
    );
    mocks.stage.mockResolvedValue(generation);

    await expect(
      stageDevelopmentGeneration({
        diagnostics: compiled.diagnostics.diagnostics,
        manifest: compiled.manifest,
        metadata: compiled.metadata,
        paths: resolveCompilerArtifactPaths(appRoot),
        project: { agentRoot: `${appRoot}/agent`, appRoot, layout: "nested" },
      }),
    ).rejects.toThrow("Development generation module-map digest mismatch");

    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
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
