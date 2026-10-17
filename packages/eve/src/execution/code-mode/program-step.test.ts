import { afterEach, describe, expect, it, vi } from "vitest";
const runtimeMock = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn() }));
vi.mock("./registry.js", () => ({ getProgramRuntime: () => runtimeMock }));
const metadata = vi.hoisted(() => ({ attempt: 2 }));
vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  getStepMetadata: () => ({ attempt: metadata.attempt }),
}));
import {
  dispatchProgramCallStep,
  recordProgramCallStartedStep,
  runProgramStep,
} from "./program-step.js";

describe("started-call replay", () => {
  it("records a stable call marker as a separate durable step", async () => {
    expect(await recordProgramCallStartedStep("program:0")).toEqual({
      status: "started",
      callId: "program:0",
    });
  });
  it("never resolves or dispatches a call whose earlier step attempt lost its result", async () => {
    // Context is deliberately unusable: touching it would prove dispatch was retried.
    const context = {
      get serializedContext() {
        throw new Error("must not hydrate replay");
      },
    } as never;
    expect(
      await dispatchProgramCallStep(
        {} as never,
        context,
        { index: 0, input: {}, tool: "write" },
        { callId: "program:0", status: "started" },
        [],
      ),
    ).toEqual({
      index: 0,
      status: "unknown",
      error: expect.stringContaining("may or may not have happened"),
    });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("interpreter step timing", () => {
  const input: import("./runtime.js").ProgramStart = {
    source: "return 1;",
    limits: { deadlineAt: 1000, memoryBytes: 1024, maxTotalCalls: 256, maxInFlightCalls: 32 },
    toolNames: [],
  };
  it("preserves runtime-provided measurements", async () => {
    runtimeMock.start.mockResolvedValue({
      status: "completed",
      output: 1,
      logs: [],
      timing: { startupMs: 3, runMs: 7 },
    });
    expect((await runProgramStep("js", input)).timing).toEqual({ startupMs: 3, runMs: 7 });
  });
  it("falls back to wall time for runtimes without measurements, including parked resumes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(125);
    runtimeMock.start.mockResolvedValue({ status: "completed", output: 1, logs: [] });
    expect((await runProgramStep("py", input)).timing).toEqual({ startupMs: 0, runMs: 25 });
    clock.mockReturnValueOnce(200).mockReturnValueOnce(235);
    runtimeMock.resume.mockResolvedValue({ status: "parked", calls: [], state: null });
    expect((await runProgramStep("py", { ...input, state: null, results: [] })).timing).toEqual({
      startupMs: 0,
      runMs: 35,
    });
  });
  it("includes fallback measurements and errorClass when runtime lookup/execution fails", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(109);
    runtimeMock.start.mockRejectedValue(new Error("interpreter crashed"));
    expect(await runProgramStep("js", input)).toEqual({
      status: "failed",
      error: "interpreter crashed",
      errorClass: "runtime",
      logs: [],
      timing: { startupMs: 0, runMs: 9 },
    });
  });
});
