import { describe, expect, expectTypeOf, it } from "vitest";

import * as sdk from "#internal/workflow/index.js";
import * as sdkRuntime from "#internal/workflow/runtime.js";

import * as api from "./api.ts";
import * as workflow from "./index.ts";

describe("eve/experimental/workflow", () => {
  it("re-exports the SDK runtime value under an eve-owned declaration", () => {
    expect(workflow.getWorkflowMetadata).toBe(sdk.getWorkflowMetadata);
    expectTypeOf(sdk.getWorkflowMetadata).toExtend<typeof workflow.getWorkflowMetadata>();
  });
});

describe("eve/experimental/workflow/api", () => {
  it("re-exports the SDK runtime values", () => {
    expect(api.start).toBe(sdkRuntime.start);
    expect(api.getRun).toBe(sdkRuntime.getRun);
  });

  it("declares signatures the SDK values satisfy", () => {
    expectTypeOf(sdkRuntime.start).toExtend<typeof api.start>();
    expectTypeOf(sdkRuntime.getRun).toExtend<typeof api.getRun>();
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
