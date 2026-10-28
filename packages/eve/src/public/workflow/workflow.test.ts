import { describe, expect, expectTypeOf, it, vi } from "vitest";

import * as sdk from "#internal/workflow/index.js";
import * as sdkRuntime from "#internal/workflow/runtime.js";

import * as api from "./api.ts";
import * as workflow from "./index.ts";

describe("eve/workflow", () => {
  it("re-exports the SDK runtime values", () => {
    expect(workflow.createHook).toBe(sdk.createHook);
    expect(workflow.createWebhook).toBe(sdk.createWebhook);
    expect(workflow.sleep).toBe(sdk.sleep);
    expect(workflow.getWorkflowMetadata).toBe(sdk.getWorkflowMetadata);
    expect(workflow.FatalError).toBe(sdk.FatalError);
    expect(workflow.RetryableError).toBe(sdk.RetryableError);
    expect(new workflow.FatalError("stop")).toBeInstanceOf(sdk.FatalError);
  });

  it("declares signatures the SDK values satisfy", () => {
    expectTypeOf(sdk.createWebhook).toExtend<typeof workflow.createWebhook>();
    expectTypeOf(sdk.getWorkflowMetadata).toExtend<typeof workflow.getWorkflowMetadata>();
    expectTypeOf(sdk.FatalError).toExtend<typeof workflow.FatalError>();
    expectTypeOf(sdk.RetryableError).toExtend<typeof workflow.RetryableError>();

    // createHook is cast only because JSON metadata uses readonly arrays.
    expectTypeOf(sdk.createHook<number>).returns.toExtend<workflow.WorkflowHook<number>>();
    expectTypeOf(sdk.createHook).toBeCallableWith({
      token: "approval",
      metadata: { sessionId: "s", tags: ["a"] },
    });

    // sleep is cast only because the SDK splits the union into overloads.
    expectTypeOf(sdk.sleep).toBeCallableWith("1h");
    expectTypeOf(sdk.sleep).toBeCallableWith(1_000);
    expectTypeOf(sdk.sleep).toBeCallableWith(new Date());
  });
});

describe("eve/workflow/api", () => {
  it("waits for hook persistence without exposing the SDK record or hiding failures", async () => {
    const persisted = Promise.withResolvers<Awaited<ReturnType<typeof sdkRuntime.resumeHook>>>();
    const resume = vi.spyOn(sdkRuntime, "resumeHook").mockReturnValueOnce(persisted.promise);
    try {
      const result = api.resumeHook("approval", { approved: true });
      expect(resume).toHaveBeenCalledWith("approval", { approved: true });
      persisted.resolve({
        runId: "run",
        hookId: "hook",
        token: "approval",
        ownerId: "owner",
        projectId: "project",
        environment: "test",
        createdAt: new Date(),
        metadata: Promise.resolve(undefined),
      });
      await expect(result).resolves.toBeUndefined();

      const failure = new Error("Hook persistence failed");
      resume.mockRejectedValueOnce(failure);
      await expect(api.resumeHook("approval", { approved: false })).rejects.toBe(failure);
    } finally {
      resume.mockRestore();
    }
  });

  it("re-exports the SDK runtime values", () => {
    expect(api.start).toBe(sdkRuntime.start);
    expect(api.getRun).toBe(sdkRuntime.getRun);
  });

  it("declares signatures the SDK values satisfy", () => {
    expectTypeOf(sdkRuntime.start).toExtend<typeof api.start>();
    expectTypeOf(sdkRuntime.getRun).toExtend<typeof api.getRun>();

    expectTypeOf(api.resumeHook<{ approved: boolean }>).toBeCallableWith("approval", {
      approved: true,
    });
    expectTypeOf(api.resumeHook).returns.resolves.toBeVoid();
  });

  it("keeps SDK-only options out of the public signatures", () => {
    async function durable(input: string): Promise<number> {
      return input.length;
    }
    // Type-checked only; calling start needs a running World.
    const calls = () => {
      expectTypeOf(api.start(durable, ["x"])).resolves.toEqualTypeOf<api.WorkflowRun<number>>();
      // @ts-expect-error Deployment, world, and queue options are not part of eve's start.
      void api.start(durable, ["x"], { deploymentId: "latest" });
      // @ts-expect-error Workflow source strings are not startable.
      void api.start("export default async function () {}");
    };
    expect(calls).toBeTypeOf("function");
    expectTypeOf<keyof api.WorkflowRun>().toEqualTypeOf<
      "runId" | "status" | "returnValue" | "cancel"
    >();
    expectTypeOf(api).not.toHaveProperty("getHookByToken");
  });
});
