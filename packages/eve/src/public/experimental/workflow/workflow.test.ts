import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import * as sdk from "#internal/workflow/index.js";
import * as sdkRuntime from "#internal/workflow/runtime.js";

import * as api from "./api.ts";
import * as workflow from "./index.ts";

vi.mock("#internal/workflow/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof sdk>()),
  getWritable: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof sdkRuntime>()),
  getRun: vi.fn(),
}));

afterEach(() => {
  vi.mocked(sdk.getWritable).mockReset();
  vi.mocked(sdkRuntime.getRun).mockReset();
});

const invalidNamespaces = [
  [undefined, /non-empty `namespace`/u],
  ["", /non-empty `namespace`/u],
  ["eve.child.session", /reserved "eve\." prefix/u],
  ["eve:mount.v1", /reserved "eve:" prefix/u],
] as const;

describe("eve/experimental/workflow", () => {
  it("re-exports the SDK metadata value under an eve-owned declaration", () => {
    expect(workflow.getWorkflowMetadata).toBe(sdk.getWorkflowMetadata);
    expectTypeOf(sdk.getWorkflowMetadata).toExtend<typeof workflow.getWorkflowMetadata>();
  });

  it("opens the namespaced stream on the current run", () => {
    const stream = new WritableStream<string>();
    vi.mocked(sdk.getWritable).mockReturnValueOnce(stream);
    expect(workflow.getWritable<string>({ namespace: "coder.progress" })).toBe(stream);
    expect(sdk.getWritable).toHaveBeenCalledWith({ namespace: "coder.progress" });
  });

  it.each(invalidNamespaces)("rejects namespace %j", (namespace, message) => {
    expect(() => workflow.getWritable({ namespace: namespace as string })).toThrow(message);
    expect(sdk.getWritable).not.toHaveBeenCalled();
  });

  it("requires a namespace in its signature", () => {
    // @ts-expect-error The default stream belongs to eve.
    expectTypeOf(workflow.getWritable).toBeCallableWith();
    expectTypeOf(workflow.getWritable<number>({ namespace: "n" })).toEqualTypeOf<
      WritableStream<number>
    >();
  });
});

describe("eve/experimental/workflow/api", () => {
  it("re-exports the SDK runtime values", async () => {
    const actual = await vi.importActual<typeof sdkRuntime>("#internal/workflow/runtime.js");
    expect(api.start).toBe(sdkRuntime.start);
    expect(api.start).toBe(actual.start);
    expectTypeOf(actual.start).toExtend<typeof api.start>();
    expectTypeOf(actual.getRun).toExtend<typeof api.getRun>();
  });

  it("reads the namespaced stream of a run from startIndex", () => {
    const stream = new ReadableStream<string>();
    const getReadable = vi.fn().mockReturnValue(stream);
    vi.mocked(sdkRuntime.getRun).mockReturnValueOnce({ getReadable } as never);
    expect(api.getReadable<string>("run_1", { namespace: "coder.progress", startIndex: -1 })).toBe(
      stream,
    );
    expect(sdkRuntime.getRun).toHaveBeenCalledWith("run_1");
    expect(getReadable).toHaveBeenCalledWith({ namespace: "coder.progress", startIndex: -1 });
  });

  it.each(invalidNamespaces)("rejects namespace %j", (namespace, message) => {
    const getReadable = vi.fn();
    vi.mocked(sdkRuntime.getRun).mockReturnValue({ getReadable } as never);
    expect(() => api.getReadable("run_1", { namespace: namespace as string })).toThrow(message);
    expect(getReadable).not.toHaveBeenCalled();
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
      // @ts-expect-error The default stream belongs to eve.
      void api.getReadable("run_1", {});
      // @ts-expect-error Hydration globals and waitUntil ops are not part of eve's reader.
      void api.getReadable("run_1", { namespace: "n", ops: [] });
    };
    expect(calls).toBeTypeOf("function");
    expectTypeOf<keyof api.WorkflowRun>().toEqualTypeOf<
      "runId" | "status" | "returnValue" | "cancel"
    >();
    expectTypeOf(api).not.toHaveProperty("getHookByToken");
  });
});
