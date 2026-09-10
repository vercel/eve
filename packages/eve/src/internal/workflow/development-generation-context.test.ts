import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  getDevelopmentWorkflowGeneration,
  withDevelopmentWorkflowGeneration,
} from "#internal/workflow/development-generation-context.js";

function generation(generationId: string) {
  return {
    generationId,
    source: createDiskRuntimeCompiledArtifactsSource(
      `/app/.eve/dev-runtime/snapshots/${generationId}/source/app`,
      {
        durableReference: "development-generation",
      },
    ),
  };
}

describe("development delivery generation", () => {
  it("survives nested context replacement without adding serialized values", async () => {
    const admitted = generation("a");
    await withDevelopmentWorkflowGeneration(admitted, async () => {
      const ctx = new ContextContainer();
      await contextStorage.run(ctx, async () => {
        await Promise.resolve();
        ctx.clearVirtualContext();
        expect(getDevelopmentWorkflowGeneration()).toBe(admitted);
        expect([...ctx.entries()]).toEqual([]);
      });
    });
    expect(getDevelopmentWorkflowGeneration()).toBeUndefined();
  });

  it("isolates overlapping deliveries", async () => {
    const first = generation("a");
    const second = generation("b");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstRun = withDevelopmentWorkflowGeneration(first, async () => {
      entered.resolve();
      await release.promise;
      expect(getDevelopmentWorkflowGeneration()).toBe(first);
    });
    const secondRun = withDevelopmentWorkflowGeneration(second, async () => {
      await entered.promise;
      expect(getDevelopmentWorkflowGeneration()).toBe(second);
      release.resolve();
      await firstRun;
      expect(getDevelopmentWorkflowGeneration()).toBe(second);
    });
    expect(getDevelopmentWorkflowGeneration()).toBeUndefined();
    await Promise.all([firstRun, secondRun]);
    expect(getDevelopmentWorkflowGeneration()).toBeUndefined();
  });

  it("restores the outer generation when a nested scope throws", async () => {
    const outer = generation("a");
    const inner = generation("b");
    await withDevelopmentWorkflowGeneration(outer, async () => {
      await expect(
        withDevelopmentWorkflowGeneration(inner, async () => {
          await Promise.resolve();
          expect(getDevelopmentWorkflowGeneration()).toBe(inner);
          throw new Error("delivery failed");
        }),
      ).rejects.toThrow("delivery failed");
      expect(getDevelopmentWorkflowGeneration()).toBe(outer);
    });
    expect(getDevelopmentWorkflowGeneration()).toBeUndefined();
  });

  it("shares the generation across module copies", async () => {
    vi.resetModules();
    const copy = await import("#internal/workflow/development-generation-context.js");
    expect(copy.getDevelopmentWorkflowGeneration).not.toBe(getDevelopmentWorkflowGeneration);
    const admitted = generation("a");
    await withDevelopmentWorkflowGeneration(admitted, async () => {
      expect(copy.getDevelopmentWorkflowGeneration()).toBe(admitted);
    });
    await copy.withDevelopmentWorkflowGeneration(admitted, async () => {
      expect(getDevelopmentWorkflowGeneration()).toBe(admitted);
    });
    expect(copy.getDevelopmentWorkflowGeneration()).toBeUndefined();
    expect(getDevelopmentWorkflowGeneration()).toBeUndefined();
  });
});
