import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodeModeProgramOutcome } from "#execution/code-mode/program-step.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";
import type { CodeModeToolCatalogEntry } from "#execution/code-mode/schema.js";
import type { ToolContext } from "#tools/definition.js";

const runProgram = vi.fn<(...args: any[]) => Promise<CodeModeProgramOutcome>>();
const executeTool =
  vi.fn<
    (
      ...args: any[]
    ) => ReturnType<typeof import("#execution/code-mode/program-step.js").executeCodeModeToolStep>
  >();
const invokeAgent = vi.fn<(...args: any[]) => Promise<unknown>>();
const ask = vi.fn<(...args: any[]) => Promise<unknown>>();
const requestInput = vi.fn<(...args: any[]) => Promise<unknown>>();
const executeWorkflowBody =
  vi.fn<
    (
      ...args: any[]
    ) => ReturnType<typeof import("#execution/tools/workflow/body.js").executeWorkflowBody>
  >();
const owner = { inbox: "owner-inbox" };
const initialSessionState = { sessionId: "s1" };
const runContext = { sessionState: initialSessionState as Record<string, unknown> };

vi.mock("#execution/code-mode/program-step.js", () => ({
  CODE_MODE_CALL_INTERRUPT_KIND: "eve.code-mode-call",
  executeCodeModeToolStep: (_ctx: unknown, ...args: unknown[]) => executeTool(...args),
  runCodeModeProgramStep: (...args: unknown[]) => runProgram(...args),
}));
vi.mock("#execution/tools/subagent/invoke-agent.js", () => ({
  invokeAgent: (...args: unknown[]) => invokeAgent(...args),
}));
vi.mock("#execution/tools/workflow/ask.js", () => ({
  ask: (_ctx: unknown, ...args: unknown[]) => ask(...args),
  requestInput: (_ctx: unknown, build: (requestId: string) => unknown) =>
    requestInput(build("approval-hook")),
  readWorkflowToolRunRef: () => ({
    callId: "outer",
    runId: "outer-run",
    sequence: 1,
    stepIndex: 2,
    turnId: "turn",
  }),
  readWorkflowToolRunOwner: () => owner,
  readCodeModeRunContext: () => ({
    serializedContext: { ctx: true },
    sessionState: runContext.sessionState,
  }),
}));
vi.mock("#execution/tools/workflow/body.js", () => ({
  executeWorkflowBody: (...args: unknown[]) => executeWorkflowBody(...args),
}));

const { codeModeWorkflow } = await import("#execution/code-mode/workflow.js");

function call(toolName: string, toolInput: unknown): WorkflowSandboxInterrupt {
  return { input: toolInput, toolCallId: `${toolName}-call`, toolName } as WorkflowSandboxInterrupt;
}

const parked = (...pending: WorkflowSandboxInterrupt[]): CodeModeProgramOutcome => ({
  interrupt: { batch: pending.map((call) => call.toolCallId) } as never,
  pending,
  status: "interrupted",
});
const completed = (output: unknown): CodeModeProgramOutcome => ({
  output: output as never,
  status: "completed",
});

const session = { id: "s1", auth: {}, turn: { id: "turn", sequence: 1 } } as ToolContext["session"];

function context(aborted = false): ToolContext {
  const controller = new AbortController();
  if (aborted) controller.abort(new Error("stop"));
  return {
    abortSignal: controller.signal,
    callId: "outer",
    session,
    toolName: "code_mode",
  } as ToolContext;
}

function entry(
  name: string,
  target: CodeModeToolCatalogEntry["target"] = "tool",
): CodeModeToolCatalogEntry {
  return {
    name,
    description: `${name}.`,
    inputSchema: { type: "object" },
    outputSchema: null,
    target,
  };
}

const planEntry: CodeModeToolCatalogEntry = {
  ...entry("plan_deploy", "workflow"),
  description: "Plan a deploy.",
  workflowId: "workflow//app//plan_deploy",
};

// The body resolves every parked call through the pinned catalog, so each tool
// the programs below call has an entry with the target the harness would pin.
const program = {
  js: "return 1;",

  maxSubagents: 100,
  toolCatalog: [
    ...["add", "ask_question", "first", "gated", "read", "second", "write"].map((name) =>
      entry(name),
    ),
    ...["a", "b", "r", "researcher"].map((name) => entry(name, "agent")),
    entry("direct_only", "direct"),
    planEntry,
    { ...planEntry, name: "gated_wf", workflowId: "workflow//app//gated_wf" },
  ],
};

const approvalRequired = {
  status: "approval-required" as const,
  approvalKey: "gated",
  action: { callId: "gated-call", input: { region: "eu" }, toolName: "gated" },
  request: { prompt: "Approve tool call: gated", options: [{ id: "approve", label: "Approve" }] },
};

beforeEach(() => {
  runContext.sessionState = initialSessionState;
  runProgram.mockReset();
  executeTool.mockReset();
  invokeAgent.mockReset();
  ask.mockReset();
  requestInput.mockReset();
  executeWorkflowBody.mockReset();
});

describe("codeModeWorkflow", () => {
  it("carries state into later calls without exposing it to the program", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("write", {})))
      .mockResolvedValueOnce(parked(call("read", {})))
      .mockResolvedValueOnce(completed("done"));
    executeTool
      .mockResolvedValueOnce({
        status: "completed",
        output: "written",
        stateChanges: [
          { path: ["serializedContext", "todo"], before: undefined, after: ["saved"] },
        ],
      })
      .mockImplementationOnce(async (input) => {
        expect(input.serializedContext).toEqual({ ctx: true, todo: ["saved"] });
        return { status: "completed", output: "read" };
      });
    await codeModeWorkflow(program, context());
    expect(runProgram.mock.calls[1]?.[0].resume).toEqual({
      interrupt: { batch: ["write-call"] },
      resolutions: [{ status: "completed", output: "written" }],
    });
  });

  it("applies batch state in pending order so the same call conflicts regardless of finish order", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("first", {}), call("second", {})))
      .mockResolvedValueOnce(completed("done"));
    const change = (after: string) => [
      { path: ["serializedContext", "todo"], before: undefined, after },
    ];
    let releaseFirst: () => void = () => {};
    executeTool
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve({ status: "completed", output: "first", stateChanges: change("from-first") });
          }),
      )
      .mockImplementationOnce(async () => {
        queueMicrotask(releaseFirst);
        return { status: "completed", output: "second", stateChanges: change("from-second") };
      });

    await codeModeWorkflow(program, context());

    const { resolutions } = runProgram.mock.calls[1]![0].resume;
    expect(resolutions[0]).toEqual({ status: "completed", output: "first" });
    expect(resolutions[1]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("CODE_MODE_STATE_CONFLICT"),
    });
  });

  it("counts failed calls and continuations against one budget across resumes", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("researcher", { message: "first" })))
      .mockResolvedValueOnce(
        parked(
          call("add", { a: 1, b: 2 }),
          call("researcher", { agentId: "existing-child", message: "continue" }),
        ),
      )
      .mockResolvedValueOnce(parked(call("researcher", { message: "excess" })))
      .mockResolvedValueOnce(completed("caught"));
    invokeAgent.mockRejectedValueOnce(new Error("child failed")).mockResolvedValueOnce("continued");
    executeTool.mockResolvedValue({ status: "completed", output: 3 });

    await expect(codeModeWorkflow({ ...program, maxSubagents: 2 }, context())).resolves.toBe(
      "caught",
    );

    expect(invokeAgent).toHaveBeenCalledTimes(2);
    expect(invokeAgent.mock.calls[1]?.[1]).toMatchObject({
      agentId: "existing-child",
      message: "continue",
    });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(runProgram.mock.calls[3]?.[0].resume.resolutions[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("CODE_MODE_SUBAGENT_LIMIT_REACHED"),
    });
  });

  it("admits concurrent calls in program order and rejects excess calls before dispatch", async () => {
    runProgram
      .mockResolvedValueOnce(
        parked(
          call("researcher", { message: "first" }),
          call("researcher", { message: "second" }),
          call("researcher", { message: "excess" }),
        ),
      )
      .mockResolvedValueOnce(completed("settled"));
    invokeAgent.mockResolvedValue("child result");

    await codeModeWorkflow({ ...program, maxSubagents: 2 }, context());

    expect(invokeAgent.mock.calls.map((args) => args[1].message)).toEqual(["first", "second"]);
    expect(
      runProgram.mock.calls[1]?.[0].resume.resolutions.map((entry: any) => entry.status),
    ).toEqual(["completed", "completed", "failed"]);
  });

  it.each([false, true])(
    "reports a failed program without replaying it (resume=%s)",
    async (resume) => {
      if (resume) {
        runProgram.mockResolvedValueOnce(parked(call("add", {})));
        executeTool.mockResolvedValueOnce({ status: "completed", output: 3 });
      }
      runProgram.mockResolvedValueOnce({ status: "failed", error: "Syntax error in program" });
      await expect(codeModeWorkflow(program, context())).rejects.toThrow("Syntax error in program");
      expect(runProgram).toHaveBeenCalledTimes(resume ? 2 : 1);
      expect(executeTool).toHaveBeenCalledTimes(resume ? 1 : 0);
    },
  );

  it("returns the program output when it completes without nested calls", async () => {
    runProgram.mockResolvedValueOnce(completed(42));
    await expect(codeModeWorkflow(program, context())).resolves.toBe(42);
    expect(runProgram).toHaveBeenCalledTimes(1);
    expect(runProgram.mock.calls[0]?.[0]).toEqual({
      callId: "outer",
      program,
      sessionState: { sessionId: "s1" },
    });
    expect(runProgram.mock.calls[0]?.[0]).not.toHaveProperty("resume");
  });

  it("executes ordinary tools in a child step and resumes the program with the result", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("add", { a: 1, b: 2 })))
      .mockResolvedValueOnce(completed(3));
    executeTool.mockResolvedValueOnce({ status: "completed", output: 3 });

    await expect(codeModeWorkflow(program, context())).resolves.toBe(3);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serializedContext: { ctx: true },
        event: { sequence: 1, stepIndex: 2, turnId: "turn" },
        toolCallId: "add-call",
        toolInput: { a: 1, b: 2 },
        toolName: "add",
      }),
    );
    expect(runProgram.mock.calls[1]?.[0]).toEqual({
      callId: "outer",
      program,
      sessionState: { sessionId: "s1" },
      resume: {
        interrupt: { batch: ["add-call"] },
        resolutions: [{ status: "completed", output: 3 }],
      },
    });
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it("routes subagent calls through the owner agent-invoke channel", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("researcher", { message: "dig" })))
      .mockResolvedValueOnce(completed("done"));
    invokeAgent.mockResolvedValueOnce("findings");

    await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.anything(),
      { message: "dig", target: "researcher" },
      { invocationId: "outer:0" },
    );
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: { resolutions: [{ status: "completed", output: "findings" }] },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("answers ask_question through the workflow-tool ask protocol", async () => {
    const options = [
      { id: "ship", label: "Ship" },
      { id: "hold", label: "Hold" },
    ];
    runProgram
      .mockResolvedValueOnce(
        parked(call("ask_question", { prompt: "Ship it?", options, allowFreeform: true })),
      )
      .mockResolvedValueOnce(completed("shipped"));
    ask.mockResolvedValueOnce({ optionId: "ship", text: undefined });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("shipped");
    expect(ask).toHaveBeenCalledWith({ prompt: "Ship it?", options, allowFreeform: true });
    expect(runProgram.mock.calls[1]?.[0]).toEqual({
      callId: "outer",
      program,
      sessionState: { sessionId: "s1" },
      resume: {
        interrupt: { batch: ["ask_question-call"] },
        resolutions: [{ status: "completed", output: { status: "answered", optionId: "ship" } }],
      },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([null, { options: [] }, { prompt: "" }])(
    "fails an ask_question call without a prompt instead of asking (%j)",
    async (toolInput) => {
      runProgram
        .mockResolvedValueOnce(parked(call("ask_question", toolInput)))
        .mockResolvedValueOnce(completed("recovered"));

      await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
      expect(ask).not.toHaveBeenCalled();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: {
          resolutions: [{ status: "failed", error: expect.stringContaining("ask_question") }],
        },
      });
    },
  );

  it("settles calls parked together concurrently and resumes once with every result", async () => {
    runProgram
      .mockResolvedValueOnce(
        parked(call("a", { message: "a" }), call("b", { message: "b" }), call("add", { n: 1 })),
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
      resume: {
        interrupt: { batch: ["a-call", "b-call", "add-call"] },
        resolutions: [
          { status: "completed", output: "a-result" },
          { status: "completed", output: "b-result" },
          { status: "completed", output: 2 },
        ],
      },
    });
  });

  it("keeps invocation ids monotonic across successive batches", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("r", { message: "1" })))
      .mockResolvedValueOnce(parked(call("r", { message: "2" }), call("r", { message: "3" })))
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
      .mockResolvedValueOnce(parked(call("add", {})))
      .mockResolvedValueOnce(completed("recovered"));
    executeTool.mockResolvedValueOnce({ status: "failed", error: "boom" });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: { resolutions: [{ status: "failed", error: "boom" }] },
    });
  });

  it("stops at the next batch once the run is cancelled", async () => {
    runProgram.mockResolvedValueOnce(parked(call("add", {})));
    await expect(codeModeWorkflow(program, context(true))).rejects.toThrow("stop");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("resumes a mixed batch with a subagent failure and its successful siblings", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("researcher", { message: "dig" }), call("add", {})))
      .mockResolvedValueOnce(completed("recovered"));
    invokeAgent.mockRejectedValueOnce({ message: "child failed" });
    executeTool.mockResolvedValueOnce({ status: "completed", output: 3 });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: {
        resolutions: [
          { status: "failed", error: "child failed" },
          { status: "completed", output: 3 },
        ],
      },
    });
  });

  it("does not turn cancellation into a catchable nested failure", async () => {
    const controller = new AbortController();
    runProgram.mockResolvedValueOnce(parked(call("researcher", { message: "dig" })));
    invokeAgent.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      throw controller.signal.reason;
    });
    await expect(
      codeModeWorkflow(program, { ...context(), abortSignal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(runProgram).toHaveBeenCalledOnce();
  });

  it("runs authored workflow tools inline under the run's own ref and resumes with the body result", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("plan_deploy", { service: "api" })))
      .mockResolvedValueOnce(completed("planned"));
    executeTool.mockResolvedValueOnce({ status: "cleared" });
    executeWorkflowBody.mockResolvedValueOnce({
      outcome: { status: "completed", output: { plan: "PLAN:api" } },
      reportCount: 1,
    });

    const ctx = context();
    await expect(codeModeWorkflow(program, ctx)).resolves.toBe("planned");
    // The step clears the call (approval, availability) but never runs the body.
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ toolName: "plan_deploy", toolInput: { service: "api" } }),
    );
    expect(executeWorkflowBody).toHaveBeenCalledWith(
      {
        authorizationSupported: true,
        callId: "outer",
        execution: "blocking",
        input: { service: "api" },
        owner,
        session,
        stepIndex: 2,
        toolName: "plan_deploy",
        workflowId: "workflow//app//plan_deploy",
      },
      ctx.abortSignal,
    );
    expect(executeWorkflowBody.mock.calls[0]?.[0]).not.toHaveProperty("codeMode");
    expect(executeWorkflowBody.mock.calls[0]?.[0]).not.toHaveProperty("runId");
    expect(runProgram.mock.calls[1]?.[0]).toEqual({
      callId: "outer",
      program,
      sessionState: { sessionId: "s1" },
      resume: {
        interrupt: { batch: ["plan_deploy-call"] },
        resolutions: [{ status: "completed", output: { plan: "PLAN:api" } }],
      },
    });
  });

  it("feeds a failed workflow body back into the program as a message", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("plan_deploy", { service: "api" })))
      .mockResolvedValueOnce(completed("recovered"));
    executeTool.mockResolvedValueOnce({ status: "cleared" });
    executeWorkflowBody.mockResolvedValueOnce({
      outcome: { status: "failed", error: { message: "plan rejected", name: "Error" } },
      reportCount: 0,
    });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: { resolutions: [{ status: "failed", error: "plan rejected" }] },
    });
  });

  it("propagates a cancelled workflow body as run cancellation", async () => {
    const controller = new AbortController();
    runProgram.mockResolvedValueOnce(parked(call("plan_deploy", { service: "api" })));
    executeTool.mockResolvedValueOnce({ status: "cleared" });
    executeWorkflowBody.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      return { outcome: { status: "cancelled", reason: "cancelled" }, reportCount: 0 };
    });

    await expect(
      codeModeWorkflow(program, { ...context(), abortSignal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(runProgram).toHaveBeenCalledOnce();
  });

  it.each([
    ["not in the catalog", "missing", { service: "api" }, 0, "not callable from this program"],
    ["kept direct", "direct_only", {}, 0, "not callable from this program"],
    ["non-object workflow input", "plan_deploy", "api", 1, "requires a JSON object input"],
  ])(
    "fails a call it cannot start instead of running anything (%s)",
    async (_label, toolName, toolInput, stepCalls, message) => {
      runProgram
        .mockResolvedValueOnce(parked(call(toolName, toolInput)))
        .mockResolvedValueOnce(completed("recovered"));
      executeTool.mockResolvedValue({ status: "cleared" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
      expect(executeTool).toHaveBeenCalledTimes(stepCalls);
      expect(executeWorkflowBody).not.toHaveBeenCalled();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: { resolutions: [{ status: "failed", error: expect.stringContaining(message) }] },
      });
    },
  );

  it("fails a cleared call whose catalog entry is not a workflow tool", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("add", {})))
      .mockResolvedValueOnce(completed("recovered"));
    executeTool.mockResolvedValueOnce({ status: "cleared" });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(executeWorkflowBody).not.toHaveBeenCalled();
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: {
        resolutions: [{ status: "failed", error: expect.stringContaining("not a workflow tool") }],
      },
    });
  });

  describe("approval-gated calls", () => {
    const snapshotState = {
      sessionId: "s1",
      snapshot: { version: 1, session: { state: { agents: ["child"] }, sandboxState: null } },
    };
    const nestedCall = {
      event: { sequence: 1, stepIndex: 2, turnId: "turn" },
      serializedContext: { ctx: true },
      sessionState: snapshotState,
      toolCallId: "gated-call",
      toolInput: { region: "eu" },
      toolName: "gated",
    };

    it("asks the person, then runs the tool with the grant and records the approval as a state change", async () => {
      runContext.sessionState = snapshotState;
      runProgram
        .mockResolvedValueOnce(parked(call("gated", { region: "eu" })))
        .mockResolvedValueOnce(parked(call("gated", { region: "us" })))
        .mockResolvedValueOnce(completed("done"));
      executeTool
        .mockResolvedValueOnce(approvalRequired)
        .mockResolvedValueOnce({
          status: "completed",
          output: "GATED",
          stateChanges: [{ path: ["serializedContext", "todo"], before: undefined, after: ["x"] }],
        })
        .mockResolvedValueOnce({ status: "completed", output: "GATED" });
      requestInput.mockResolvedValueOnce({ optionId: "approve" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      // First step call carries no grant; the step answers with the policy's request.
      expect(executeTool.mock.calls[0]).toEqual([nestedCall]);
      // The body sends a complete tool-approval request attributed to the nested call.
      expect(requestInput).toHaveBeenCalledExactlyOnceWith({
        ...approvalRequired.request,
        action: { ...approvalRequired.action, kind: "tool-call" },
        kind: "tool-approval",
        requestId: "approval-hook",
      });
      // The second step call carries the grant so the policy is skipped and the tool runs.
      expect(executeTool.mock.calls[1]).toEqual([{ ...nestedCall, approval: { key: "gated" } }]);
      expect(ask).not.toHaveBeenCalled();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: { resolutions: [{ status: "completed", output: "GATED" }] },
      });
      // The cursor carries the approval on to later calls (and the parent),
      // alongside the tool's own context updates, so the next call is a single
      // step that the policy clears from the recorded approval.
      expect(executeTool.mock.calls[2]).toEqual([
        {
          ...nestedCall,
          serializedContext: { ctx: true, todo: ["x"] },
          sessionState: {
            sessionId: "s1",
            snapshot: {
              version: 1,
              session: {
                state: { agents: ["child"], "eve.runtime.hitl.approvedTools": ["gated"] },
                sandboxState: null,
              },
            },
          },
          toolInput: { region: "us" },
        },
      ]);
      expect(executeTool).toHaveBeenCalledTimes(3);
    });

    it("rejects the call with CODE_MODE_APPROVAL_DENIED and never runs the tool when declined", async () => {
      runProgram
        .mockResolvedValueOnce(parked(call("gated", {})))
        .mockResolvedValueOnce(completed("recovered"));
      executeTool.mockResolvedValueOnce(approvalRequired);
      requestInput.mockResolvedValueOnce({ optionId: "cancel" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
      expect(executeTool).toHaveBeenCalledOnce();
      expect(executeTool.mock.calls[0]?.[0]).not.toHaveProperty("approval");
      expect(runProgram.mock.calls[1]?.[0]).toEqual({
        callId: "outer",
        program,
        sessionState: { sessionId: "s1" },
        resume: {
          interrupt: { batch: ["gated-call"] },
          resolutions: [
            {
              status: "failed",
              error: 'CODE_MODE_APPROVAL_DENIED: the user declined to run "gated".',
            },
          ],
        },
      });
    });

    it("runs the tool in one step when the policy does not require approval", async () => {
      runProgram
        .mockResolvedValueOnce(parked(call("gated", {})))
        .mockResolvedValueOnce(completed("done"));
      executeTool.mockResolvedValueOnce({ status: "completed", output: "GATED" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      expect(requestInput).not.toHaveBeenCalled();
      expect(executeTool).toHaveBeenCalledOnce();
      expect(executeTool.mock.calls[0]?.[0]).not.toHaveProperty("approval");
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        sessionState: { sessionId: "s1" },
        resume: { resolutions: [{ status: "completed", output: "GATED" }] },
      });
      expect(runProgram.mock.calls[1]?.[0].sessionState).not.toHaveProperty("snapshot");
    });

    it.each([
      'CODE_MODE_APPROVAL_DENIED: the approval policy declined to run "gated".',
      'CODE_MODE_APPROVAL_DENIED: the approval policy declined to run "gated". outside business hours',
      "not available",
    ])(
      "feeds a step-side policy failure %j back into the program without asking",
      async (error) => {
        runProgram
          .mockResolvedValueOnce(parked(call("gated", {})))
          .mockResolvedValueOnce(completed("recovered"));
        executeTool.mockResolvedValueOnce({ status: "failed", error });

        await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
        expect(requestInput).not.toHaveBeenCalled();
        expect(executeTool).toHaveBeenCalledOnce();
        expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
          resume: { resolutions: [{ status: "failed", error }] },
        });
      },
    );

    it("settles ungated tools and workflow tools with one step call each and no prompt", async () => {
      runProgram
        .mockResolvedValueOnce(parked(call("add", {}), call("plan_deploy", {})))
        .mockResolvedValueOnce(completed("done"));
      executeTool.mockImplementation(async (input) =>
        input.toolName === "plan_deploy"
          ? { status: "cleared" }
          : { status: "completed", output: 3 },
      );
      executeWorkflowBody.mockResolvedValueOnce({
        outcome: { status: "completed", output: "planned" },
        reportCount: 0,
      });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      expect(requestInput).not.toHaveBeenCalled();
      expect(executeTool).toHaveBeenCalledTimes(2);
      for (const [input] of executeTool.mock.calls) expect(input).not.toHaveProperty("approval");
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: {
          resolutions: [
            { status: "completed", output: 3 },
            { status: "completed", output: "planned" },
          ],
        },
      });
    });

    it("gates authored workflow tools before running their body inline", async () => {
      runContext.sessionState = snapshotState;
      runProgram
        .mockResolvedValueOnce(parked(call("gated_wf", { service: "api" })))
        .mockResolvedValueOnce(parked(call("add", {})))
        .mockResolvedValueOnce(completed("done"));
      executeTool
        .mockResolvedValueOnce({
          ...approvalRequired,
          approvalKey: "gated_wf",
          action: { callId: "gated_wf-call", input: { service: "api" }, toolName: "gated_wf" },
        })
        .mockResolvedValueOnce({ status: "cleared" })
        .mockResolvedValueOnce({ status: "completed", output: 3 });
      requestInput.mockResolvedValueOnce({ optionId: "approve" });
      executeWorkflowBody.mockResolvedValueOnce({
        outcome: { status: "completed", output: "planned" },
        reportCount: 0,
      });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      expect(requestInput).toHaveBeenCalledOnce();
      expect(executeTool.mock.calls[1]?.[0]).toMatchObject({
        toolName: "gated_wf",
        approval: { key: "gated_wf" },
      });
      expect(executeWorkflowBody).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ toolName: "gated_wf", workflowId: "workflow//app//gated_wf" }),
        expect.anything(),
      );
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: { resolutions: [{ status: "completed", output: "planned" }] },
      });
      expect(executeTool.mock.calls[2]?.[0]).toMatchObject({
        toolName: "add",
        sessionState: {
          snapshot: {
            session: {
              state: { agents: ["child"], "eve.runtime.hitl.approvedTools": ["gated_wf"] },
            },
          },
        },
      });
    });

    it("fails the call instead of asking again when the granted step still wants approval", async () => {
      runProgram
        .mockResolvedValueOnce(parked(call("gated", { region: "eu" })))
        .mockResolvedValueOnce(completed("recovered"));
      executeTool.mockResolvedValue(approvalRequired);
      requestInput.mockResolvedValueOnce({ optionId: "approve" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
      expect(requestInput).toHaveBeenCalledOnce();
      expect(executeTool).toHaveBeenCalledTimes(2);
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: {
          resolutions: [
            { status: "failed", error: expect.stringContaining("asked for approval twice") },
          ],
        },
      });
    });
  });

  it("rejects malformed durable input before touching the sandbox", async () => {
    await expect(codeModeWorkflow({ js: 1 }, context())).rejects.toThrow('"js" string');
    expect(runProgram).not.toHaveBeenCalled();
  });
});
