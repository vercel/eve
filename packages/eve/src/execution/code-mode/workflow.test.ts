import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CodeModePendingCall,
  CodeModeProgramOutcome,
} from "#execution/code-mode/program-step.js";
import type { ToolContext } from "#tools/definition.js";
import type { CodeModeCallResolution } from "#execution/code-mode/schema.js";

const runProgram = vi.fn<(...args: any[]) => Promise<CodeModeProgramOutcome>>();
const executeTool = vi.fn<(...args: any[]) => Promise<CodeModeCallResolution>>();
const invokeAgent = vi.fn<(...args: any[]) => Promise<unknown>>();

vi.mock("#execution/code-mode/program-step.js", () => ({
  CODE_MODE_CALL_INTERRUPT_KIND: "eve.code-mode-call",
  runCodeModeProgramStep: (...args: unknown[]) => runProgram(...args),
}));
vi.mock("#execution/code-mode/authorization.js", () => ({
  executeCodeModeTool: (_ctx: unknown, ...args: unknown[]) => executeTool(...args),
}));
vi.mock("#execution/tools/subagent/invoke-agent.js", () => ({
  invokeAgent: (...args: unknown[]) => invokeAgent(...args),
}));
vi.mock("#execution/tools/workflow/ask.js", () => ({
  readWorkflowToolRunRef: () => ({ sequence: 1, stepIndex: 2, turnId: "turn" }),
  readCodeModeRunContext: () => ({
    serializedContext: { ctx: true },
    sessionState: { sessionId: "s1" },
  }),
}));

const { codeModeWorkflow } = await import("#execution/code-mode/workflow.js");

function call(target: "agent" | "tool", toolName: string, toolInput: unknown): CodeModePendingCall {
  return {
    call: { kind: "eve.code-mode-call", target, toolInput, toolName },
    interrupt: { marker: toolName } as never,
    toolCallId: `${toolName}-call`,
  };
}

const parked = (...pending: CodeModePendingCall[]): CodeModeProgramOutcome => ({
  pending,
  status: "interrupted",
});
const completed = (output: unknown): CodeModeProgramOutcome => ({
  output: output as never,
  status: "completed",
});

function context(aborted = false): ToolContext {
  const controller = new AbortController();
  if (aborted) controller.abort(new Error("stop"));
  return { abortSignal: controller.signal, callId: "outer", toolName: "code_mode" } as ToolContext;
}

const program = {
  js: "return 1;",
  mode: "eager",
  toolNames: ["add", "researcher"],
  toolCatalog: [],
};

beforeEach(() => {
  runProgram.mockReset();
  executeTool.mockReset();
  invokeAgent.mockReset();
});

describe("codeModeWorkflow", () => {
  it("returns the program output when it completes without nested calls", async () => {
    runProgram.mockResolvedValueOnce(completed(42));
    await expect(codeModeWorkflow(program, context())).resolves.toBe(42);
    expect(runProgram).toHaveBeenCalledTimes(1);
    expect(runProgram.mock.calls[0]?.[0]).toMatchObject({
      callId: "outer",
      program,
      serializedContext: { ctx: true },
    });
    expect(runProgram.mock.calls[0]?.[0]).not.toHaveProperty("resume");
  });

  it("executes ordinary tools in a child step and resumes the program with the result", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("tool", "add", { a: 1, b: 2 })))
      .mockResolvedValueOnce(completed(3));
    executeTool.mockResolvedValueOnce({ status: "completed", output: 3 });

    await expect(codeModeWorkflow(program, context())).resolves.toBe(3);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "add-call",
        toolInput: { a: 1, b: 2 },
        toolName: "add",
      }),
    );
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: [{ interrupt: { marker: "add" }, resolution: { status: "completed", output: 3 } }],
    });
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it("routes subagent calls through the owner agent-invoke channel", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("agent", "researcher", { message: "dig" })))
      .mockResolvedValueOnce(completed("done"));
    invokeAgent.mockResolvedValueOnce("findings");

    await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.anything(),
      { message: "dig", target: "researcher" },
      { invocationId: "outer:0" },
    );
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: [{ resolution: { status: "completed", output: "findings" } }],
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("settles calls parked together concurrently and resumes once with every result", async () => {
    runProgram
      .mockResolvedValueOnce(
        parked(
          call("agent", "a", { message: "a" }),
          call("agent", "b", { message: "b" }),
          call("tool", "add", { n: 1 }),
        ),
      )
      .mockResolvedValueOnce(completed(null));

    // Hold every settle open until all three have started, so a sequential
    // implementation would deadlock here instead of passing.
    let started = 0;
    const gate = new Promise<void>((resolve) => {
      const check = () => {
        if (started === 3) resolve();
      };
      invokeAgent.mockImplementation(async (_ctx, input: { message: string }) => {
        started++;
        check();
        await gate;
        return `${input.message}-result`;
      });
      executeTool.mockImplementation(async () => {
        started++;
        check();
        await gate;
        return { status: "completed", output: 2 };
      });
    });

    await expect(codeModeWorkflow(program, context())).resolves.toBeNull();
    expect(started).toBe(3);
    expect(invokeAgent.mock.calls.map((c) => c[2])).toEqual([
      { invocationId: "outer:0" },
      { invocationId: "outer:1" },
    ]);
    expect(runProgram).toHaveBeenCalledTimes(2);
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: [
        { interrupt: { marker: "a" }, resolution: { status: "completed", output: "a-result" } },
        { interrupt: { marker: "b" }, resolution: { status: "completed", output: "b-result" } },
        { interrupt: { marker: "add" }, resolution: { status: "completed", output: 2 } },
      ],
    });
  });

  it("keeps invocation ids monotonic across successive batches", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("agent", "r", { message: "1" })))
      .mockResolvedValueOnce(
        parked(call("agent", "r", { message: "2" }), call("agent", "r", { message: "3" })),
      )
      .mockResolvedValueOnce(completed(null));
    invokeAgent.mockResolvedValue("ok");

    await codeModeWorkflow(program, context());
    expect(invokeAgent.mock.calls.map((c) => c[2])).toEqual([
      { invocationId: "outer:0" },
      { invocationId: "outer:1" },
      { invocationId: "outer:2" },
    ]);
  });

  it("feeds tool failures back into the program instead of failing the run", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("tool", "add", {})))
      .mockResolvedValueOnce(completed("recovered"));
    executeTool.mockResolvedValueOnce({ status: "failed", error: "boom" });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: [{ resolution: { status: "failed", error: "boom" } }],
    });
  });

  it("stops at the next batch once the run is cancelled", async () => {
    runProgram.mockResolvedValueOnce(parked(call("tool", "add", {})));
    await expect(codeModeWorkflow(program, context(true))).rejects.toThrow("stop");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("resumes a mixed batch with a subagent failure and its successful siblings", async () => {
    runProgram
      .mockResolvedValueOnce(
        parked(call("agent", "researcher", { message: "dig" }), call("tool", "add", {})),
      )
      .mockResolvedValueOnce(completed("recovered"));
    invokeAgent.mockRejectedValueOnce({ message: "child failed" });
    executeTool.mockResolvedValueOnce({ status: "completed", output: 3 });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: [
        { resolution: { status: "failed", error: "child failed" } },
        { resolution: { status: "completed", output: 3 } },
      ],
    });
  });

  it("does not turn cancellation into a catchable nested failure", async () => {
    const controller = new AbortController();
    runProgram.mockResolvedValueOnce(parked(call("agent", "researcher", { message: "dig" })));
    invokeAgent.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      throw controller.signal.reason;
    });
    await expect(
      codeModeWorkflow(program, { ...context(), abortSignal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(runProgram).toHaveBeenCalledOnce();
  });

  it("rejects malformed durable input before touching the sandbox", async () => {
    await expect(codeModeWorkflow({ js: 1 }, context())).rejects.toThrow('"js" string');
    expect(runProgram).not.toHaveBeenCalled();
  });
});
