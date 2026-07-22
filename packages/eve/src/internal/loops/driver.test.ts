import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { resolveLoopDriver } from "#internal/loops/driver.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const mocks = vi.hoisted(() => ({
  createInlineLoopRuntime: vi.fn(),
  createWorkflowRuntime: vi.fn(),
  loadInlineRuntimeModule: vi.fn(),
}));

vi.mock("#internal/loops/workflow/runtime.js", () => ({
  createWorkflowRuntime: mocks.createWorkflowRuntime,
}));

vi.mock("#internal/loops/local-runtime-loader.js", () => ({
  loadInlineRuntimeModule: mocks.loadInlineRuntimeModule,
  loadTemporalRuntimeModule: vi.fn(),
}));

const source = createBundledRuntimeCompiledArtifactsSource();
const runtime = {} as Runtime;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadInlineRuntimeModule.mockResolvedValue({
    createInlineLoopRuntime: mocks.createInlineLoopRuntime,
  });
});

describe("resolveLoopDriver", () => {
  it("selects the existing Workflow Runtime by default", async () => {
    mocks.createWorkflowRuntime.mockReturnValue(runtime);

    const driver = await resolveLoopDriver({ compiledArtifactsSource: source, environment: {} });

    expect(driver.kind).toBe("workflow");
    expect(driver.createRuntime({ nodeId: "researcher" })).toBe(runtime);
    expect(mocks.createWorkflowRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: source,
      nodeId: "researcher",
    });
  });

  it("binds the inline implementation to the selected artifact source", async () => {
    mocks.createInlineLoopRuntime.mockReturnValue(runtime);

    const driver = await resolveLoopDriver({
      compiledArtifactsSource: source,
      environment: { EVE_LOOP: "inline" },
    });

    expect(driver.kind).toBe("inline");
    expect(driver.createRuntime()).toBe(runtime);
    expect(mocks.createInlineLoopRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: source,
      nodeId: undefined,
    });
  });

  it.each(["inline", "temporal"] as const)("rejects local-only %s on Vercel", async (kind) => {
    await expect(
      resolveLoopDriver({
        compiledArtifactsSource: source,
        environment: { EVE_LOOP: kind, VERCEL_ENV: "preview" },
      }),
    ).rejects.toThrow("Vercel Function");
  });
});
