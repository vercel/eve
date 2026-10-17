import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
const mocks = vi.hoisted(() => ({ createWorkflowSandboxTool: vi.fn() }));
vi.mock("#shared/workflow-sandbox.js", () => mocks);
import { JavaScriptProgramRuntime } from "./javascript.js";
import type { ProgramStart, ProgramStep } from "./runtime.js";

const program: ProgramStart = {
  source: "const a = await tools.read({}); return await tools.read(a);",
  toolNames: ["read"],
  limits: {
    deadlineAt: Number.MAX_SAFE_INTEGER,
    memoryBytes: 123456,
    maxTotalCalls: 256,
    maxInFlightCalls: 32,
  },
};
let runtime: JavaScriptProgramRuntime;
let visits: number[];
let iterations: number;
const runtimes: JavaScriptProgramRuntime[] = [];
function parked(step: ProgramStep) {
  expect(step.status).toBe("parked");
  if (step.status !== "parked") throw new Error(JSON.stringify(step));
  return step;
}
async function invoke(tools: ToolSet, name: string, input: unknown) {
  return (await tools[name]!.execute!(input as never, {} as never)) as {
    status: string;
    output: number;
    error: string;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  visits = [];
  iterations = 2;
  runtime = new JavaScriptProgramRuntime();
  runtimes.push(runtime);
  mocks.createWorkflowSandboxTool.mockImplementation(
    async ({ hostTools }: { hostTools: ToolSet }) => ({
      execute: async () => {
        await invoke(hostTools, "ready", {});
        let output = 0;
        for (let index = 0; index < iterations; index++) {
          visits.push(index);
          const pending = invoke(hostTools, "call", {
            index,
            input: {},
            tool: "read",
            logs: ["before"],
          });
          await invoke(hostTools, "park", { logs: ["before"] });
          const result = await pending;
          if (result.status !== "completed")
            return {
              status: "failed",
              error: result.error,
              errorClass: "runtime",
              logs: ["before"],
            };
          output = result.output;
        }
        return { status: "completed", output, logs: ["before"] };
      },
    }),
  );
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("JavaScriptProgramRuntime live bridge", () => {
  it("configures memory, deadline, and bounded tool/checkpoint traffic", async () => {
    parked(await runtime.start(program));
    expect(mocks.createWorkflowSandboxTool).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          memoryLimitBytes: 123456,
          maxInFlightBridgeRequests: 34,
          maxBridgeRequests: 515,
        }),
        hostTools: { call: expect.anything(), park: expect.anything(), ready: expect.anything() },
      }),
    );
  });

  it("keeps one execution alive and visits each call once across resumes", async () => {
    const first = parked(await runtime.start(program));
    const second = parked(
      await runtime.resume({
        ...program,
        state: first.state,
        results: [{ index: 0, status: "completed", output: 41 }],
      }),
    );
    expect(first.timing!.startupMs).toBeGreaterThanOrEqual(0);
    expect(first.timing!.runMs).toBeGreaterThanOrEqual(0);
    expect(second.timing!.startupMs).toBe(0);
    expect(second.timing!.runMs).toBeGreaterThanOrEqual(0);
    expect(second.calls.map((call) => call.index)).toEqual([1]);
    expect(
      await runtime.resume({
        ...program,
        state: second.state,
        results: [
          { index: 0, status: "completed", output: 41 },
          { index: 1, status: "completed", output: 42 },
        ],
      }),
    ).toMatchObject({ status: "completed", output: 42 });
    expect(mocks.createWorkflowSandboxTool).toHaveBeenCalledTimes(1);
    expect(visits).toEqual([0, 1]);
    expect((Reflect.get(runtime, "executions") as Map<string, unknown>).size).toBe(0);
  });

  it("separates startup from execution and excludes idle time before a live resume", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(117)
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(504);
    const first = parked(await runtime.start(program));
    expect(first.timing).toEqual({ startupMs: 10, runMs: 7 });
    const next = parked(
      await runtime.resume({
        ...program,
        state: first.state,
        results: [{ index: 0, status: "completed", output: 41 }],
      }),
    );
    expect(next.timing).toEqual({ startupMs: 0, runMs: 4 });
  });

  it("visits exactly 100 bridge calls, not 5,050, for 100 sequential resumes", async () => {
    iterations = 100;
    let step = await runtime.start(program);
    const results = [];
    while (step.status === "parked") {
      for (const call of step.calls)
        results.push({ index: call.index, status: "completed" as const, output: call.index + 1 });
      step = await runtime.resume({ ...program, state: step.state, results });
    }
    expect(step).toMatchObject({ status: "completed", output: 100 });
    expect(visits).toEqual(Array.from({ length: 100 }, (_, index) => index));
    expect(mocks.createWorkflowSandboxTool).toHaveBeenCalledTimes(1);
  });

  it("fails closed if a restarted interpreter diverges from the recorded call inputs", async () => {
    const first = parked(await runtime.start(program));
    runtime.close();
    mocks.createWorkflowSandboxTool.mockImplementationOnce(
      async ({ hostTools }: { hostTools: ToolSet }) => ({
        execute: async () =>
          invoke(hostTools, "call", {
            index: 0,
            input: { different: true },
            tool: "read",
            logs: [],
          }),
      }),
    );
    expect(
      await runtime.resume({
        ...program,
        state: first.state,
        results: [{ index: 0, status: "completed", output: 41 }],
      }),
    ).toMatchObject({
      status: "failed",
      error: "Recorded program call differs during interpreter replay.",
    });
  });

  it("rejects incomplete recorded results and releases the parked interpreter", async () => {
    const first = parked(await runtime.start(program));
    expect(await runtime.resume({ ...program, state: first.state, results: [] })).toMatchObject({
      status: "failed",
      error: "Missing recorded result for a program call.",
    });
    expect((Reflect.get(runtime, "executions") as Map<string, unknown>).size).toBe(0);
  });

  it("replays recorded results on a process cache miss, exposing only the next unresolved call", async () => {
    const first = parked(await runtime.start(program));
    runtime.close();
    const restarted = new JavaScriptProgramRuntime();
    runtimes.push(restarted);
    const second = parked(
      await restarted.resume({
        ...program,
        state: JSON.parse(JSON.stringify(first.state)),
        results: [{ index: 0, status: "completed", output: 41 }],
      }),
    );
    expect(second.calls.map((call) => call.index)).toEqual([1]);
    expect(mocks.createWorkflowSandboxTool).toHaveBeenCalledTimes(2);
    expect(visits).toEqual([0, 0, 1]);
  });

  it("replays stale checkpoints rather than feeding results into a newer live frontier", async () => {
    const first = parked(await runtime.start(program));
    const results = [{ index: 0, status: "completed" as const, output: 41 }];
    const second = parked(await runtime.resume({ ...program, state: first.state, results }));
    const replayed = parked(await runtime.resume({ ...program, state: first.state, results }));
    expect(replayed.calls).toEqual(second.calls);
    expect(mocks.createWorkflowSandboxTool).toHaveBeenCalledTimes(2);
  });

  it("converts unknown outcomes to a rejected guest call without retrying it", async () => {
    const first = parked(await runtime.start(program));
    expect(
      await runtime.resume({
        ...program,
        state: first.state,
        results: [{ index: 0, status: "unknown", error: "crash" }],
      }),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("side effect may or may not have happened"),
      logs: ["before"],
    });
    expect(visits).toEqual([0]);
  });

  it("expires and releases a live parked execution at its original deadline", async () => {
    vi.useFakeTimers();
    const input = { ...program, limits: { ...program.limits, deadlineAt: Date.now() + 100 } };
    const first = parked(await runtime.start(input));
    await vi.advanceTimersByTimeAsync(101);
    expect((Reflect.get(runtime, "executions") as Map<string, unknown>).size).toBe(0);
    expect(await runtime.resume({ ...input, state: first.state, results: [] })).toMatchObject({
      status: "failed",
      errorClass: "deadline",
      logs: ["before"],
    });
  });

  it("closes parked executions explicitly and rejects mismatched program state", async () => {
    const first = parked(await runtime.start(program));
    const call = mocks.createWorkflowSandboxTool.mock.calls[0]![0];
    expect(
      await runtime.resume({ ...program, source: "return 1;", state: first.state, results: [] }),
    ).toMatchObject({ status: "failed", error: "Invalid JavaScript program state." });
    runtime.close();
    expect((Reflect.get(runtime, "executions") as Map<string, unknown>).size).toBe(0);
    expect(call.hostTools.call).toBeDefined();
  });

  it("rejects an expired deadline before starting the interpreter", async () => {
    expect(
      await runtime.start({ ...program, limits: { ...program.limits, deadlineAt: 0 } }),
    ).toMatchObject({ status: "failed", errorClass: "deadline" });
    expect(mocks.createWorkflowSandboxTool).not.toHaveBeenCalled();
  });

  it("returns interpreter errors as classified failures", async () => {
    for (const [error, errorClass] of [
      ["SyntaxError: unexpected token", "syntax"],
      ["out of memory", "memory"],
      ["Code mode execution timed out", "deadline"],
    ]) {
      mocks.createWorkflowSandboxTool.mockRejectedValueOnce(new Error(error));
      expect(await runtime.start(program)).toMatchObject({
        status: "failed",
        error,
        errorClass,
        logs: [],
      });
    }
  });
});
