import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CodeModePendingCall,
  CodeModeProgramOutcome,
} from "#execution/code-mode/program-step.js";
import type { ToolContext } from "#tools/definition.js";

const runProgram = vi.fn<(...args: any[]) => Promise<CodeModeProgramOutcome>>();
const executeTool =
  vi.fn<
    (
      ...args: any[]
    ) => ReturnType<typeof import("#execution/code-mode/program-step.js").executeCodeModeToolStep>
  >();
const evaluateApproval =
  vi.fn<
    (
      ...args: any[]
    ) => ReturnType<
      typeof import("#execution/code-mode/program-step.js").evaluateCodeModeApprovalStep
    >
  >();
const invokeAgent = vi.fn<(...args: any[]) => Promise<unknown>>();
const ask = vi.fn<(...args: any[]) => Promise<unknown>>();
const askApproval = vi.fn<(...args: any[]) => Promise<unknown>>();
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
  evaluateCodeModeApprovalStep: (...args: unknown[]) => evaluateApproval(...args),
  executeCodeModeToolStep: (_ctx: unknown, ...args: unknown[]) => executeTool(...args),
  runCodeModeProgramStep: (...args: unknown[]) => runProgram(...args),
}));
vi.mock("#execution/tools/subagent/invoke-agent.js", () => ({
  invokeAgent: (...args: unknown[]) => invokeAgent(...args),
}));
vi.mock("#execution/tools/workflow/ask.js", () => ({
  ask: (_ctx: unknown, ...args: unknown[]) => ask(...args),
  askApproval: (_ctx: unknown, ...args: unknown[]) => askApproval(...args),
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

function call(
  target: CodeModePendingCall["call"]["target"],
  toolName: string,
  toolInput: unknown,
): CodeModePendingCall {
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

const planEntry = {
  name: "plan_deploy",
  description: "Plan a deploy.",
  inputSchema: { type: "object" },
  outputSchema: null,
  target: "workflow" as const,
  workflowId: "workflow//app//plan_deploy",
};

const gatedEntry = {
  name: "gated",
  description: "Needs approval.",
  inputSchema: { type: "object" },
  outputSchema: null,
  target: "tool" as const,
  approval: true as const,
};

const program = {
  js: "return 1;",

  maxSubagents: 100,
  toolCatalog: [planEntry, gatedEntry, { ...planEntry, name: "gated_wf", approval: true as const }],
};

const approvalRequired = {
  status: "required" as const,
  approvalKey: "gated",
  action: { callId: "gated-call", input: { region: "eu" }, toolName: "gated" },
  request: { prompt: "Approve tool call: gated", options: [{ id: "approve", label: "Approve" }] },
};

beforeEach(() => {
  runContext.sessionState = initialSessionState;
  runProgram.mockReset();
  executeTool.mockReset();
  evaluateApproval.mockReset();
  invokeAgent.mockReset();
  ask.mockReset();
  askApproval.mockReset();
  executeWorkflowBody.mockReset();
});

describe("codeModeWorkflow", () => {
  it("carries state into later calls without exposing it to the program", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("tool", "write", {})))
      .mockResolvedValueOnce(parked(call("tool", "read", {})))
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
    expect(runProgram.mock.calls[1]?.[0].resume[0].resolution).toEqual({
      status: "completed",
      output: "written",
    });
  });

  it("applies batch state in pending order so the same call conflicts regardless of finish order", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("tool", "first", {}), call("tool", "second", {})))
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

    const resume = runProgram.mock.calls[1]?.[0].resume;
    expect(resume[0].resolution).toEqual({ status: "completed", output: "first" });
    expect(resume[1].resolution).toMatchObject({
      status: "failed",
      error: expect.stringContaining("CODE_MODE_STATE_CONFLICT"),
    });
  });

  it("counts failed calls and continuations against one budget across resumes", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("agent", "researcher", { message: "first" })))
      .mockResolvedValueOnce(
        parked(
          call("tool", "add", { a: 1, b: 2 }),
          call("agent", "researcher", { agentId: "existing-child", message: "continue" }),
        ),
      )
      .mockResolvedValueOnce(parked(call("agent", "researcher", { message: "excess" })))
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
    expect(runProgram.mock.calls[3]?.[0].resume[0].resolution).toMatchObject({
      status: "failed",
      error: expect.stringContaining("CODE_MODE_SUBAGENT_LIMIT_REACHED"),
    });
  });

  it("admits concurrent calls in program order and rejects excess calls before dispatch", async () => {
    runProgram
      .mockResolvedValueOnce(
        parked(
          call("agent", "researcher", { message: "first" }),
          call("agent", "researcher", { message: "second" }),
          call("agent", "researcher", { message: "excess" }),
        ),
      )
      .mockResolvedValueOnce(completed("settled"));
    invokeAgent.mockResolvedValue("child result");

    await codeModeWorkflow({ ...program, maxSubagents: 2 }, context());

    expect(invokeAgent.mock.calls.map((args) => args[1].message)).toEqual(["first", "second"]);
    expect(
      runProgram.mock.calls[1]?.[0].resume.map((entry: any) => entry.resolution.status),
    ).toEqual(["completed", "completed", "failed"]);
  });

  it.each([false, true])(
    "reports a failed program without replaying it (resume=%s)",
    async (resume) => {
      if (resume) {
        runProgram.mockResolvedValueOnce(parked(call("tool", "add", {})));
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
      .mockResolvedValueOnce(parked(call("tool", "add", { a: 1, b: 2 })))
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

  it("answers ask_question through the workflow-tool ask protocol", async () => {
    const options = [
      { id: "ship", label: "Ship" },
      { id: "hold", label: "Hold" },
    ];
    runProgram
      .mockResolvedValueOnce(
        parked(call("tool", "ask_question", { prompt: "Ship it?", options, allowFreeform: true })),
      )
      .mockResolvedValueOnce(completed("shipped"));
    ask.mockResolvedValueOnce({ optionId: "ship", text: undefined });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("shipped");
    expect(ask).toHaveBeenCalledWith({ prompt: "Ship it?", options, allowFreeform: true });
    expect(runProgram.mock.calls[1]?.[0]).toEqual({
      callId: "outer",
      program,
      sessionState: { sessionId: "s1" },
      resume: [
        {
          interrupt: { marker: "ask_question" },
          resolution: { status: "completed", output: { status: "answered", optionId: "ship" } },
        },
      ],
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([null, { options: [] }, { prompt: "" }])(
    "fails an ask_question call without a prompt instead of asking (%j)",
    async (toolInput) => {
      runProgram
        .mockResolvedValueOnce(parked(call("tool", "ask_question", toolInput)))
        .mockResolvedValueOnce(completed("recovered"));

      await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
      expect(ask).not.toHaveBeenCalled();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: [
          {
            resolution: { status: "failed", error: expect.stringContaining("ask_question") },
          },
        ],
      });
    },
  );

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

  it("runs authored workflow tools inline under the run's own ref and resumes with the body result", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("workflow", "plan_deploy", { service: "api" })))
      .mockResolvedValueOnce(completed("planned"));
    executeWorkflowBody.mockResolvedValueOnce({
      outcome: { status: "completed", output: { plan: "PLAN:api" } },
      reportCount: 1,
    });

    const ctx = context();
    await expect(codeModeWorkflow(program, ctx)).resolves.toBe("planned");
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
      resume: [
        {
          interrupt: { marker: "plan_deploy" },
          resolution: { status: "completed", output: { plan: "PLAN:api" } },
        },
      ],
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("feeds a failed workflow body back into the program as a message", async () => {
    runProgram
      .mockResolvedValueOnce(parked(call("workflow", "plan_deploy", { service: "api" })))
      .mockResolvedValueOnce(completed("recovered"));
    executeWorkflowBody.mockResolvedValueOnce({
      outcome: { status: "failed", error: { message: "plan rejected", name: "Error" } },
      reportCount: 0,
    });

    await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
    expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
      resume: [{ resolution: { status: "failed", error: "plan rejected" } }],
    });
  });

  it("propagates a cancelled workflow body as run cancellation", async () => {
    const controller = new AbortController();
    runProgram.mockResolvedValueOnce(parked(call("workflow", "plan_deploy", { service: "api" })));
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
    ["unknown", "missing", { service: "api" }, "not a workflow tool"],
    ["non-object input", "plan_deploy", "api", "requires a JSON object input"],
  ])(
    "fails a workflow call it cannot start instead of running a body (%s)",
    async (_label, toolName, toolInput, message) => {
      runProgram
        .mockResolvedValueOnce(parked(call("workflow", toolName, toolInput)))
        .mockResolvedValueOnce(completed("recovered"));

      await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
      expect(executeWorkflowBody).not.toHaveBeenCalled();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: [{ resolution: { status: "failed", error: expect.stringContaining(message) } }],
      });
    },
  );

  describe("approval-gated calls", () => {
    const snapshotState = {
      sessionId: "s1",
      snapshot: { version: 1, session: { state: { agents: ["child"] }, sandboxState: null } },
    };

    it("asks the person, then runs the tool and records the approval as a state change", async () => {
      runContext.sessionState = snapshotState;
      runProgram
        .mockResolvedValueOnce(parked(call("tool", "gated", { region: "eu" })))
        .mockResolvedValueOnce(parked(call("tool", "gated", { region: "us" })))
        .mockResolvedValueOnce(completed("done"));
      evaluateApproval
        .mockResolvedValueOnce(approvalRequired)
        .mockResolvedValueOnce({ status: "not-required" });
      askApproval.mockResolvedValueOnce({ optionId: "approve" });
      executeTool
        .mockResolvedValueOnce({
          status: "completed",
          output: "GATED",
          stateChanges: [{ path: ["serializedContext", "todo"], before: undefined, after: ["x"] }],
        })
        .mockResolvedValueOnce({ status: "completed", output: "GATED" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      const nestedCall = {
        event: { sequence: 1, stepIndex: 2, turnId: "turn" },
        serializedContext: { ctx: true },
        sessionState: snapshotState,
        toolCallId: "gated-call",
        toolInput: { region: "eu" },
        toolName: "gated",
      };
      expect(evaluateApproval.mock.calls[0]).toEqual([nestedCall]);
      expect(askApproval).toHaveBeenCalledExactlyOnceWith(
        approvalRequired.request,
        approvalRequired.action,
      );
      expect(executeTool.mock.calls[0]).toEqual([nestedCall]);
      expect(ask).not.toHaveBeenCalled();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: [{ resolution: { status: "completed", output: "GATED" } }],
      });
      // The cursor carries the approval on to later calls (and the parent),
      // alongside the tool's own context updates.
      const later = {
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
      };
      expect(evaluateApproval.mock.calls[1]).toEqual([later]);
      expect(executeTool.mock.calls[1]).toEqual([later]);
    });

    it("rejects the call with CODE_MODE_APPROVAL_DENIED and never runs the tool when declined", async () => {
      runProgram
        .mockResolvedValueOnce(parked(call("tool", "gated", {})))
        .mockResolvedValueOnce(completed("recovered"));
      evaluateApproval.mockResolvedValueOnce(approvalRequired);
      askApproval.mockResolvedValueOnce({ optionId: "cancel" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
      expect(executeTool).not.toHaveBeenCalled();
      expect(runProgram.mock.calls[1]?.[0]).toEqual({
        callId: "outer",
        program,
        sessionState: { sessionId: "s1" },
        resume: [
          {
            interrupt: { marker: "gated" },
            resolution: {
              status: "failed",
              error: 'CODE_MODE_APPROVAL_DENIED: the user declined to run "gated".',
            },
          },
        ],
      });
    });

    it("runs the tool directly when the policy does not require approval", async () => {
      runProgram
        .mockResolvedValueOnce(parked(call("tool", "gated", {})))
        .mockResolvedValueOnce(completed("done"));
      evaluateApproval.mockResolvedValueOnce({ status: "not-required" });
      executeTool.mockResolvedValueOnce({ status: "completed", output: "GATED" });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      expect(askApproval).not.toHaveBeenCalled();
      expect(executeTool).toHaveBeenCalledOnce();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        sessionState: { sessionId: "s1" },
        resume: [{ resolution: { status: "completed", output: "GATED" } }],
      });
      expect(runProgram.mock.calls[1]?.[0].sessionState).not.toHaveProperty("snapshot");
    });

    it.each([
      [{ status: "denied" as const }, 'the approval policy declined to run "gated".'],
      [
        { status: "denied" as const, reason: "outside business hours" },
        'the approval policy declined to run "gated". outside business hours',
      ],
      [{ status: "failed" as const, error: "not available" }, "not available"],
    ])(
      "feeds a policy decision %j back into the program without asking",
      async (decision, message) => {
        runProgram
          .mockResolvedValueOnce(parked(call("tool", "gated", {})))
          .mockResolvedValueOnce(completed("recovered"));
        evaluateApproval.mockResolvedValueOnce(decision);

        await expect(codeModeWorkflow(program, context())).resolves.toBe("recovered");
        expect(askApproval).not.toHaveBeenCalled();
        expect(executeTool).not.toHaveBeenCalled();
        expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
          resume: [{ resolution: { status: "failed", error: expect.stringContaining(message) } }],
        });
      },
    );

    it("skips approval evaluation for catalog entries without the marker", async () => {
      runProgram
        .mockResolvedValueOnce(parked(call("tool", "add", {}), call("workflow", "plan_deploy", {})))
        .mockResolvedValueOnce(completed("done"));
      executeTool.mockResolvedValueOnce({ status: "completed", output: 3 });
      executeWorkflowBody.mockResolvedValueOnce({
        outcome: { status: "completed", output: "planned" },
        reportCount: 0,
      });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      expect(evaluateApproval).not.toHaveBeenCalled();
    });

    it("gates authored workflow tools before running their body inline", async () => {
      runContext.sessionState = snapshotState;
      runProgram
        .mockResolvedValueOnce(parked(call("workflow", "gated_wf", { service: "api" })))
        .mockResolvedValueOnce(parked(call("tool", "add", {})))
        .mockResolvedValueOnce(completed("done"));
      evaluateApproval.mockResolvedValueOnce({ ...approvalRequired, approvalKey: "gated_wf" });
      askApproval.mockResolvedValueOnce({ optionId: "approve" });
      executeWorkflowBody.mockResolvedValueOnce({
        outcome: { status: "completed", output: "planned" },
        reportCount: 0,
      });
      executeTool.mockResolvedValueOnce({ status: "completed", output: 3 });

      await expect(codeModeWorkflow(program, context())).resolves.toBe("done");
      expect(executeWorkflowBody).toHaveBeenCalledOnce();
      expect(runProgram.mock.calls[1]?.[0]).toMatchObject({
        resume: [{ resolution: { status: "completed", output: "planned" } }],
      });
      expect(executeTool.mock.calls[0]?.[0]).toMatchObject({
        sessionState: {
          snapshot: {
            session: {
              state: { agents: ["child"], "eve.runtime.hitl.approvedTools": ["gated_wf"] },
            },
          },
        },
      });
    });
  });

  it("rejects malformed durable input before touching the sandbox", async () => {
    await expect(codeModeWorkflow({ js: 1 }, context())).rejects.toThrow('"js" string');
    expect(runProgram).not.toHaveBeenCalled();
  });
});
