import { describe, expect, it, vi } from "vitest";

import type { TestWorkflowEnvironment } from "@temporalio/testing";

import { TemporalLoopRuntime } from "./runtime.js";
import { TemporalLoopService } from "./service.js";

describe("TemporalLoopRuntime", () => {
  it("rejects new work after its Worker stops", async () => {
    const failure = new Error("worker failed");
    const worker = {
      options: { taskQueue: "test-task-queue" },
      run: () => Promise.reject(failure),
      shutdown: vi.fn(),
    };
    const runtime = new TemporalLoopRuntime({
      compiledArtifactsSource: { kind: "bundled" },
      environment: {} as TestWorkflowEnvironment,
      service: new TemporalLoopService(),
      worker,
    });
    await Promise.resolve();

    await expect(
      runtime.deliver({
        continuationToken: "missing",
        payload: { message: "hello" },
      }),
    ).rejects.toThrow("Local Temporal loop runtime Worker stopped.");
  });
});
