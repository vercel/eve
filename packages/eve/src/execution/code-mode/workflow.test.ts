import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodeModeProgramOutcome } from "#execution/code-mode/program-step.js";
import type { ToolContext } from "#tools/definition.js";

const runProgram = vi.fn<(...args: any[]) => Promise<CodeModeProgramOutcome>>();
const executeTool = vi.fn<(...args: any[]) => Promise<{ isError: boolean; output: unknown }>>();
const invokeAgent = vi.fn<(...args: any[]) => Promise<unknown>>();

vi.mock("#execution/code-mode/program-step.js", () => ({
  CODE_MODE_CALL_INTERRUPT_KIND: "eve.code-mode-call",
  executeCodeModeToolStep: (...args: unknown[]) => executeTool(...args),
  runCodeModeProgramStep: (...args: unknown[]) => runProgram(...args),
}));
vi.mock("#execution/tools/subagent/invoke-agent.js", () => ({
  invokeAgent: (...args: unknown[]) => invokeAgent(...args),
}));
vi.mock("#execution/tools/workflow/ask.js", () => ({
  readCodeModeRunContext: () => ({
    serializedContext: { ctx: true },
    sessionState: { sessionId: "s1" },
  }),
}));

const { codeModeWorkflow } = await import("#execution/code-mode/workflow.js");

const interrupt = (target: "agent" | "tool", toolName: string, toolInput: unknown) =>
  ({
    call: { kind: "eve.code-mode-call", target, toolInput, toolName },
    interrupt: { marker: `${toolName}` } as never,
    status: "interrupted",
    toolCallId: `${toolName}-call`,
  }) satisfies CodeModeProgramOutcome;

function context(aborted = false): ToolContext {
  const controller = new AbortController();
  if (aborted) controller.abort(new Error("stop"));
  return { abortSignal: controller.signal, callId: "outer", toolName: "code_mode" } as ToolContext;
}

const program = { js: "return 1;", mode: "eager", toolNames: ["add", "researcher"] };

beforeEach(() => {
  runProgram.mockReset();
  executeTool.mockReset();
  invokeAgent.mockReset();
});

describe("codeModeWorkflow", () => {
  it("returns the program output when it completes without nested calls", async () => {
    runProgram.mockResolvedValueOnce({ output: 42, status: "completed" });
    await expect(codeModeWorkflow(program, context())).resolves.toBe(42);
    expect(runProgram).toHaveBeenCalledTimes(1);
    expect(runProgram.mock.calls[0]?.[0]).toMatchObject({
      callId: "outer",
      program,
      serializedContext: { ctx: true },
    });
  });

  it("executes ordinary tools in a child step and resumes the program with the result", async () => {
    runProgram
      .mockResolvedValueOnce(interrupt("tool", "add", { a: 1, b: 2 }))
      .mockResolvedValueOnce({ output: 3, status: "completed" });
    executeTool.mockResolvedValueOnce({ isError: false, output: 3 });

    await expect(codeModeWorkflow(program, context())).resolves.toBe(3);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "add-call",
        toolInput: { a: 1, b: 2 },
        toolName: "add",
      }),
    );
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: { interrupt: { marker: "add" }, resolution: 3 },
    });
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it("routes subagent calls through the owner agent-invoke channel", async () => {
    runProgram
      .mockResolvedValueOnce(interrupt("agent", "researcher", { message: "dig" }))
      .mockResolvedValueOnce({ output: "done", status: "completed" });
    invokeAgent.mockResolvedValueOnce("findings");

    await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.anything(),
      { message: "dig", target: "researcher" },
      { invocationId: "outer:0" },
    );
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: { resolution: "findings" },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("gives each nested call a distinct replay-stable invocation id", async () => {
    runProgram
      .mockResolvedValueOnce(interrupt("agent", "researcher", { message: "a" }))
      .mockResolvedValueOnce(interrupt("agent", "researcher", { message: "b" }))
      .mockResolvedValueOnce({ output: null, status: "completed" });
    invokeAgent.mockResolvedValue("ok");

    await codeModeWorkflow(program, context());
    expect(invokeAgent.mock.calls.map((call) => call[2])).toEqual([
      { invocationId: "outer:0" },
      { invocationId: "outer:1" },
    ]);
  });

  it("feeds tool failures back into the program instead of failing the run", async () => {
    runProgram
      .mockResolvedValueOnce(interrupt("tool", "add", {}))
      .mockResolvedValueOnce({ output: "recovered", status: "completed" });
    executeTool.mockResolvedValueOnce({ isError: true, output: "boom" });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: { resolution: { error: "boom" } },
    });
  });

  it("stops at the next nested call once the run is cancelled", async () => {
    runProgram.mockResolvedValueOnce(interrupt("tool", "add", {}));
    await expect(codeModeWorkflow(program, context(true))).rejects.toThrow("stop");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects malformed durable input before touching the sandbox", async () => {
    await expect(codeModeWorkflow({ js: 1 }, context())).rejects.toThrow('"js" string');
    expect(runProgram).not.toHaveBeenCalled();
  });
});
