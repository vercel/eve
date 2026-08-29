import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { runStep } from "#context/run-step.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { backgroundToolExecutionProvider } from "#execution/tasks/parent/tool-execution.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import {
  BackgroundToolExecutorKey,
  registerSubagentTaskLauncher,
} from "#harness/background-tools.js";
import { isAuthorizationPendingModelOutput, requestAuthorization } from "#harness/authorization.js";
import { applyCodeModeTool, CODE_MODE_TOOL_NAME } from "#harness/code-mode-sandbox.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessSession } from "#harness/types.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import {
  getAgentHandleStore,
  type AgentAddress,
  type AgentIdentity,
} from "#harness/handles/store.js";
import { defineTool, type TaskExec, type ToolContext } from "#tools/definition.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#tools/framework/task-contract.js";
import { toInputSchema, toOutputSchema } from "#tools/schema.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
import { createSubagentExecutorBinding } from "#tasks/types.js";

const mocks = vi.hoisted(() => ({
  beginBackgroundTask: vi.fn(),
  propagateSubagentExecutorCancel: vi.fn(),
  rejectDelegatedDispatch: vi.fn(),
  sendTaskCommand: vi.fn(),
  sendTaskInboundPayload: vi.fn(),
}));

vi.mock("#execution/tasks/parent/delegate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/delegate.js")>()),
  beginBackgroundTask: mocks.beginBackgroundTask,
  rejectDelegatedDispatch: mocks.rejectDelegatedDispatch,
}));
vi.mock("#execution/tasks/parent/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/dispatch.js")>()),
  propagateSubagentExecutorCancel: mocks.propagateSubagentExecutorCancel,
}));
vi.mock("#execution/tasks/parent/run-parent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/run-parent.js")>()),
  sendTaskCommand: mocks.sendTaskCommand,
  sendTaskInboundPayload: mocks.sendTaskInboundPayload,
}));

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

const childIdentity: AgentIdentity = {
  id: "ag_research:operation1",
  name: "research",
  nodeId: "node_research",
};
const childAddress: AgentAddress = {
  continuationToken: "continuation_child",
  kind: "agent/local",
  sessionId: "session_child",
};

function createParentSession(): HarnessSession {
  return setHarnessEmissionState(
    {
      agent: { modelReference: { id: "mock" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
    },
    { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
  );
}

function createSubagentTool(observedBatchSizes?: number[]): HarnessToolDefinition {
  const definition = defineTool({
    description: "Spawn a research subagent.",
    execution: "background",
    inputSchema: z.strictObject({ fail: z.boolean().optional() }),
    outputSchema: SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA,
    execute(input: { readonly fail?: boolean }, _ctx: ToolContext, background: TaskExec) {
      observedBatchSizes?.push(background.batch.length);
      if (input.fail === true) throw new Error("staged launch failed");
      return background.delegated({
        executor: createSubagentExecutorBinding({
          address: childAddress,
          identity: childIdentity,
        }),
        receipt: { agentId: childIdentity.id },
      });
    },
  });
  const execute = createToolExecuteWithAuth({
    execute: definition.execute,
    execution: definition.execution,
    scope: "research",
  });
  registerSubagentTaskLauncher(execute, {
    mode: "local",
    preview: ({ callId }) => ({
      agentId: childIdentity.id,
      status: "working",
      taskId: `task-${callId}`,
    }),
  });
  return {
    description: definition.description,
    execute,
    execution: definition.execution,
    inputSchema: toInputSchema(definition.inputSchema),
    name: "research",
    outputSchema: toOutputSchema(definition.outputSchema),
  };
}

const subagentToolCallModel = () =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          input: "{}",
          toolCallId: "call-research",
          toolName: "research",
          type: "tool-call",
        },
      ],
      finishReason: { raw: undefined, unified: "tool-calls" },
      usage,
      warnings: [],
    },
  });

describe("background tool execution", () => {
  beforeEach(() => {
    mocks.beginBackgroundTask.mockReset();
    mocks.propagateSubagentExecutorCancel.mockReset();
    mocks.rejectDelegatedDispatch.mockReset();
    mocks.sendTaskCommand.mockReset();
    mocks.sendTaskInboundPayload.mockReset();
  });

  it("runs a non-subagent defineTool through the generic durable task lifecycle", async () => {
    mocks.beginBackgroundTask.mockImplementation(
      async ({ callId }: { readonly callId: string }) => ({
        createdByStepIndex: 0,
        createdByTurnId: "turn-1",
        metadata: { kind: "tool", name: "export" },
        taskId: `task-${callId}`,
        taskInboxToken: `inbox-${callId}`,
        taskRunId: `run-${callId}`,
      }),
    );
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    let releaseSiblingExecutors: (() => void) | undefined;
    const siblingExecutorsStarted = new Promise<void>((resolve) => {
      releaseSiblingExecutors = resolve;
    });
    const startedQueries: string[] = [];
    const observedBatchSizes: number[] = [];

    const definition = defineTool({
      description: "Start an external export.",
      execution: "background",
      inputSchema: z.strictObject({ query: z.string() }),
      async execute(input: { readonly query: string }, _ctx: ToolContext, background: TaskExec) {
        startedQueries.push(input.query);
        observedBatchSizes.push(background.batch.length);
        if (startedQueries.length === 2) releaseSiblingExecutors?.();
        await siblingExecutorsStarted;
        return background.delegated({
          executor: { data: { exportId: input.query }, kind: "export" },
          receipt: { exportId: input.query },
        });
      },
    });
    const tool: HarnessToolDefinition = {
      description: definition.description,
      execute: createToolExecuteWithAuth({
        execute: definition.execute,
        execution: definition.execution,
        scope: "export",
      }),
      execution: definition.execution,
      inputSchema: toInputSchema(definition.inputSchema),
      name: "export",
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ query: "export-1" }),
              toolCallId: "call-export-1",
              toolName: "export",
              type: "tool-call",
            },
            {
              input: JSON.stringify({ query: "export-2" }),
              toolCallId: "call-export-2",
              toolName: "export",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              input: JSON.stringify({ query: "export-3" }),
              toolCallId: "call-export-3",
              toolName: "export",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      ],
    });
    const session: HarnessSession = setHarnessEmissionState(
      {
        agent: { modelReference: { id: "mock" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent-session",
      },
      { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
    );
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    const generated: Awaited<ReturnType<typeof generateText>>[] = [];
    const result = await runStep(
      ctx,
      session,
      async (current) => {
        generated.push(
          await generateText({
            model,
            prompt: "Start two exports.",
            tools: buildToolSet({ tools: new Map([[tool.name, tool]]) }),
          }),
          await generateText({
            model,
            prompt: "Start one more export.",
            tools: buildToolSet({ tools: new Map([[tool.name, tool]]) }),
          }),
        );
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(startedQueries).toEqual(["export-1", "export-2", "export-3"]);
    expect(observedBatchSizes).toEqual([2, 2, 1]);
    expect(generated.flatMap((result) => result.toolResults)).toEqual(
      expect.arrayContaining(
        ["export-1", "export-2", "export-3"].map((exportId, index) =>
          expect.objectContaining({
            output: {
              exportId,
              status: "working",
              taskId: `task-call-export-${index + 1}`,
            },
            toolName: "export",
          }),
        ),
      ),
    );
    expect(result.backgroundTasks).toHaveLength(3);
    expect(getSessionTaskIndex(result.session.state)).toEqual(
      expect.arrayContaining(
        ["export-1", "export-2", "export-3"].map((exportId, index) =>
          expect.objectContaining({
            executor: { data: { exportId }, kind: "export" },
            metadata: { kind: "tool", name: "export" },
            taskId: `task-call-export-${index + 1}`,
          }),
        ),
      ),
    );
    expect(mocks.sendTaskCommand).toHaveBeenCalledTimes(3);
    expect(mocks.rejectDelegatedDispatch).not.toHaveBeenCalled();
  });

  it("send delivers progress and terminal commands after delegation", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "export" },
      taskId: "task-export",
      taskInboxToken: "inbox-export",
      taskRunId: "run-export",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    mocks.sendTaskInboundPayload.mockResolvedValue("delivered");
    let background: TaskExec | undefined;
    const definition = defineTool({
      description: "Start an external export.",
      execution: "background",
      inputSchema: z.strictObject({ query: z.string() }),
      execute(input: { readonly query: string }, _ctx: ToolContext, taskExec: TaskExec) {
        background = taskExec;
        return taskExec.delegated({
          executor: { data: { exportId: input.query }, kind: "export" },
          receipt: { exportId: input.query },
        });
      },
    });
    const tool: HarnessToolDefinition = {
      description: definition.description,
      execute: createToolExecuteWithAuth({
        execute: definition.execute,
        execution: definition.execution,
        scope: "export",
      }),
      execution: definition.execution,
      inputSchema: toInputSchema(definition.inputSchema),
      name: "export",
    };
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            input: JSON.stringify({ query: "customers" }),
            toolCallId: "call-export",
            toolName: "export",
            type: "tool-call",
          },
        ],
        finishReason: { raw: undefined, unified: "tool-calls" },
        usage,
        warnings: [],
      },
    });
    const session: HarnessSession = setHarnessEmissionState(
      {
        agent: { modelReference: { id: "mock" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent-session",
      },
      { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
    );
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    await runStep(
      ctx,
      session,
      async (current) => {
        await generateText({
          model,
          prompt: "Start the export.",
          tools: buildToolSet({ tools: new Map([[tool.name, tool]]) }),
        });
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(background).toBeDefined();
    await background!.send({
      kind: "update",
      message: "Exported 10 rows.",
    });
    await background!.send({
      kind: "update",
      message: "Exported 20 rows.",
    });
    expect(mocks.sendTaskInboundPayload).toHaveBeenNthCalledWith(1, {
      payload: {
        callId: "call-export",
        kind: "task-update",
        message: "Exported 10 rows.",
        updateEpoch: "task-export",
        updateIndex: 0,
      },
      taskInboxToken: "inbox-export",
    });
    expect(mocks.sendTaskInboundPayload).toHaveBeenNthCalledWith(2, {
      payload: {
        callId: "call-export",
        kind: "task-update",
        message: "Exported 20 rows.",
        updateEpoch: "task-export",
        updateIndex: 1,
      },
      taskInboxToken: "inbox-export",
    });

    await background!.send({ data: { rows: 10 }, kind: "complete" });
    expect(mocks.sendTaskCommand).toHaveBeenLastCalledWith({
      command: { data: { rows: 10 }, kind: "complete" },
      taskInboxToken: "inbox-export",
    });

    mocks.sendTaskCommand.mockResolvedValue("unreachable");
    await expect(background!.send({ kind: "cancel" })).rejects.toThrow(
      'Task run "task-export" did not accept "cancel".',
    );
  });

  it("rejects a delegated generic executor without cancel propagation when the parent step fails", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "export" },
      taskId: "task-export",
      taskInboxToken: "inbox-export",
      taskRunId: "run-export",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    const definition = defineTool({
      description: "Start an external export.",
      execution: "background",
      inputSchema: z.strictObject({ query: z.string() }),
      execute(input: { readonly query: string }, _ctx: ToolContext, background: TaskExec) {
        return background.delegated({
          executor: { data: { exportId: input.query }, kind: "export" },
          receipt: { exportId: input.query },
        });
      },
    });
    const tool: HarnessToolDefinition = {
      description: definition.description,
      execute: createToolExecuteWithAuth({
        execute: definition.execute,
        execution: definition.execution,
        scope: "export",
      }),
      execution: definition.execution,
      inputSchema: toInputSchema(definition.inputSchema),
      name: "export",
    };
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            input: JSON.stringify({ query: "customers" }),
            toolCallId: "call-export",
            toolName: "export",
            type: "tool-call",
          },
        ],
        finishReason: { raw: undefined, unified: "tool-calls" },
        usage,
        warnings: [],
      },
    });
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    await expect(
      runStep(
        ctx,
        session,
        async () => {
          await generateText({
            model,
            prompt: "Start the export.",
            tools: buildToolSet({ tools: new Map([[tool.name, tool]]) }),
          });
          throw new Error("parent step failed");
        },
        [backgroundToolExecutionProvider],
      ),
    ).rejects.toThrow("parent step failed");

    expect(mocks.rejectDelegatedDispatch).toHaveBeenCalledWith({
      error: { code: "PARENT_STEP_FAILED", message: "parent step failed" },
      task: {
        ...task,
        executor: { data: { exportId: "customers" }, kind: "export" },
      },
    });
    expect(mocks.propagateSubagentExecutorCancel).not.toHaveBeenCalled();
    expect(getSessionTaskIndex(session.state)).toEqual([]);
  });

  it("commits the subagent executor's addressed handle with the step", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "research" },
      taskId: "task-research",
      taskInboxToken: "inbox-research",
      taskRunId: "run-research",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    const tool = createSubagentTool();
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    const result = await runStep(
      ctx,
      session,
      async (current) => {
        await generateText({
          model: subagentToolCallModel(),
          prompt: "Spawn the researcher.",
          tools: buildToolSet({ tools: new Map([[tool.name, tool]]) }),
        });
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(getAgentHandleStore(result.session.state)?.handles).toEqual([
      { address: childAddress, identity: childIdentity, phase: "addressed" },
    ]);
    expect(getSessionTaskIndex(result.session.state)).toEqual([
      expect.objectContaining({
        executor: createSubagentExecutorBinding({
          address: childAddress,
          identity: childIdentity,
        }),
        taskId: task.taskId,
      }),
    ]);
    expect(mocks.rejectDelegatedDispatch).not.toHaveBeenCalled();
    expect(mocks.propagateSubagentExecutorCancel).not.toHaveBeenCalled();
  });

  it("stages code-mode launches before committing their complete task batch", async () => {
    mocks.beginBackgroundTask.mockImplementation(
      async ({ callId }: { readonly callId: string }) => ({
        createdByStepIndex: 0,
        createdByTurnId: "turn-1",
        metadata: { kind: "tool", name: "research" },
        taskId: `task-${callId}`,
        taskInboxToken: `inbox-${callId}`,
        taskRunId: `run-${callId}`,
      }),
    );
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    const batchSizes: number[] = [];
    const tool = createSubagentTool(batchSizes);
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);
    let output: unknown;

    const result = await runStep(
      ctx,
      session,
      async (current) => {
        const harnessTools = new Map([[tool.name, tool]]);
        const advertised = await applyCodeModeTool({
          emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
          harnessTools,
          session: current,
          tools: buildToolSet({ tools: harnessTools }),
        });
        const execute = advertised.modelTools[CODE_MODE_TOOL_NAME]?.execute;
        if (execute === undefined) throw new Error("code_mode has no executor");
        output = await execute(
          { js: "return await Promise.all([tools.research({}), tools.research({})]);" },
          { messages: [], toolCallId: "code-mode-stage" } as never,
        );
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(output).toEqual([
      { agentId: childIdentity.id, status: "working", taskId: "task-code-mode-stage:tool-1" },
      { agentId: childIdentity.id, status: "working", taskId: "task-code-mode-stage:tool-2" },
    ]);
    expect(batchSizes).toEqual([2, 2]);
    expect(result.backgroundTasks).toHaveLength(2);
    expect(getSessionTaskIndex(result.session.state)).toHaveLength(2);
  });

  it("creates no tasks when a staged code-mode program fails", async () => {
    const tool = createSubagentTool();
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    const result = await runStep(
      ctx,
      session,
      async (current) => {
        const harnessTools = new Map([[tool.name, tool]]);
        const advertised = await applyCodeModeTool({
          emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
          harnessTools,
          session: current,
          tools: buildToolSet({ tools: harnessTools }),
        });
        const execute = advertised.modelTools[CODE_MODE_TOOL_NAME]?.execute;
        if (execute === undefined) throw new Error("code_mode has no executor");
        await expect(
          execute({ js: "await tools.research({}); throw new Error('program failed');" }, {
            messages: [],
            toolCallId: "code-mode-failed",
          } as never),
        ).rejects.toThrow("program failed");
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(mocks.beginBackgroundTask).not.toHaveBeenCalled();
    expect(result.backgroundTasks).toBeUndefined();
  });

  it("compensates every staged sibling when a post-program launch fails", async () => {
    mocks.beginBackgroundTask.mockImplementation(
      async ({ callId }: { readonly callId: string }) => ({
        createdByStepIndex: 0,
        createdByTurnId: "turn-1",
        metadata: { kind: "tool", name: "research" },
        taskId: `task-${callId}`,
        taskInboxToken: `inbox-${callId}`,
        taskRunId: `run-${callId}`,
      }),
    );
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    mocks.rejectDelegatedDispatch.mockResolvedValue(undefined);
    const tool = createSubagentTool();
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    const result = await runStep(
      ctx,
      session,
      async (current) => {
        const harnessTools = new Map([[tool.name, tool]]);
        const advertised = await applyCodeModeTool({
          emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
          harnessTools,
          session: current,
          tools: buildToolSet({ tools: harnessTools }),
        });
        const execute = advertised.modelTools[CODE_MODE_TOOL_NAME]?.execute;
        if (execute === undefined) throw new Error("code_mode has no executor");
        await expect(
          execute(
            {
              js: "return await Promise.all([tools.research({}), tools.research({ fail: true })]);",
            },
            { messages: [], toolCallId: "code-mode-launch-failure" } as never,
          ),
        ).rejects.toThrow("staged launch failed");
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(mocks.beginBackgroundTask).toHaveBeenCalledTimes(2);
    expect(mocks.rejectDelegatedDispatch).toHaveBeenCalledTimes(2);
    expect(result.backgroundTasks).toBeUndefined();
    expect(getSessionTaskIndex(result.session.state)).toEqual([]);
  });

  it("cancels a dispatched child when task bind delivery fails", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "research" },
      taskId: "task-code-mode-bind:tool-1",
      taskInboxToken: "inbox-code-mode-bind:tool-1",
      taskRunId: "run-code-mode-bind:tool-1",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.sendTaskCommand.mockResolvedValue("unreachable");
    mocks.rejectDelegatedDispatch.mockResolvedValue(undefined);
    const tool = createSubagentTool();
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    await expect(
      runStep(
        ctx,
        session,
        async (current) => {
          const harnessTools = new Map([[tool.name, tool]]);
          const advertised = await applyCodeModeTool({
            emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
            harnessTools,
            session: current,
            tools: buildToolSet({ tools: harnessTools }),
          });
          await advertised.modelTools[CODE_MODE_TOOL_NAME]!.execute!(
            { js: "return await tools.research({});" },
            { messages: [], toolCallId: "code-mode-bind" } as never,
          );
          return { next: null, session: current };
        },
        [backgroundToolExecutionProvider],
      ),
    ).rejects.toThrow('did not accept "bind"');

    expect(mocks.propagateSubagentExecutorCancel).toHaveBeenCalledWith({
      bundle: undefined,
      executor: { address: childAddress, identity: childIdentity },
      taskId: task.taskId,
    });
  });

  it("does not compensate the same staged call twice", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "research" },
      taskId: "task-repeat",
      taskInboxToken: "inbox-repeat",
      taskRunId: "run-repeat",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    mocks.rejectDelegatedDispatch.mockResolvedValue(undefined);
    const tool = createSubagentTool();
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    const result = await runStep(
      ctx,
      session,
      async (current) => {
        const tools = buildToolSet({ tools: new Map([[tool.name, tool]]) });
        await tools.research!.onInputAvailable!({
          context: undefined,
          input: {},
          messages: [],
          toolCallId: "repeat",
        });
        await tools.research!.execute!({}, { messages: [], toolCallId: "repeat" } as never);
        const executor = ctx.require(BackgroundToolExecutorKey);
        await executor.rollbackCalls!({ callIds: new Set(["repeat"]), cause: new Error("failed") });
        await executor.rollbackCalls!({ callIds: new Set(["repeat"]), cause: new Error("failed") });
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(mocks.rejectDelegatedDispatch).toHaveBeenCalledOnce();
    expect(mocks.propagateSubagentExecutorCancel).toHaveBeenCalledOnce();
    expect(result.backgroundTasks).toBeUndefined();
  });

  it("retains staged launches when the parent turn is cancelled afterward", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "research" },
      taskId: "task-code-mode-cancel:tool-1",
      taskInboxToken: "inbox-code-mode-cancel:tool-1",
      taskRunId: "run-code-mode-cancel:tool-1",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    const tool = createSubagentTool();
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    await expect(
      runStep(
        ctx,
        session,
        async (current) => {
          const harnessTools = new Map([[tool.name, tool]]);
          const advertised = await applyCodeModeTool({
            emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
            harnessTools,
            session: current,
            tools: buildToolSet({ tools: harnessTools }),
          });
          await advertised.modelTools[CODE_MODE_TOOL_NAME]!.execute!(
            { js: "return await tools.research({});" },
            { messages: [], toolCallId: "code-mode-cancel" } as never,
          );
          throw new TurnCancelledError();
        },
        [backgroundToolExecutionProvider],
      ),
    ).rejects.toThrow(TurnCancelledError);

    expect(mocks.rejectDelegatedDispatch).not.toHaveBeenCalled();
  });

  it("rejects the task first and then cancels the dispatched subagent child when the parent step fails", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "research" },
      taskId: "task-research",
      taskInboxToken: "inbox-research",
      taskRunId: "run-research",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.sendTaskCommand.mockResolvedValue("delivered");
    mocks.rejectDelegatedDispatch.mockResolvedValue(undefined);
    mocks.propagateSubagentExecutorCancel.mockResolvedValue(undefined);
    const tool = createSubagentTool();
    const session = createParentSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);

    await expect(
      runStep(
        ctx,
        session,
        async () => {
          await generateText({
            model: subagentToolCallModel(),
            prompt: "Spawn the researcher.",
            tools: buildToolSet({ tools: new Map([[tool.name, tool]]) }),
          });
          throw new Error("parent step failed");
        },
        [backgroundToolExecutionProvider],
      ),
    ).rejects.toThrow("parent step failed");

    const executor = createSubagentExecutorBinding({
      address: childAddress,
      identity: childIdentity,
    });
    expect(mocks.rejectDelegatedDispatch).toHaveBeenCalledWith({
      error: { code: "PARENT_STEP_FAILED", message: "parent step failed" },
      task: { ...task, executor },
    });
    expect(mocks.propagateSubagentExecutorCancel).toHaveBeenCalledWith({
      bundle: undefined,
      executor: { address: childAddress, identity: childIdentity },
      taskId: task.taskId,
    });
    // The task must be terminal before the child learns anything: a late
    // child result then bounces instead of reviving the rejected task.
    expect(mocks.rejectDelegatedDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.propagateSubagentExecutorCancel.mock.invocationCallOrder[0] ?? 0,
    );
    expect(getSessionTaskIndex(session.state)).toEqual([]);
  });

  it("parks authorization without committing the provisional task", async () => {
    const task = {
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "export" },
      taskId: "task-export",
      taskInboxToken: "inbox-export",
      taskRunId: "run-export",
    } as const;
    mocks.beginBackgroundTask.mockResolvedValue(task);
    mocks.rejectDelegatedDispatch.mockResolvedValue(undefined);
    const signal = requestAuthorization([
      {
        challenge: { url: "https://idp.example/authorize" },
        hookUrl: "https://app.example/callback",
        name: "exports",
      },
    ]);
    const tool: HarnessToolDefinition = {
      description: "Start an authorized export.",
      execute: async () => signal,
      execution: "background",
      inputSchema: z.strictObject({}),
      name: "export",
    };
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            input: "{}",
            toolCallId: "call-export",
            toolName: "export",
            type: "tool-call",
          },
        ],
        finishReason: { raw: undefined, unified: "tool-calls" },
        usage,
        warnings: [],
      },
    });
    const session: HarnessSession = setHarnessEmissionState(
      {
        agent: { modelReference: { id: "mock" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent-session",
      },
      { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
    );
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, session.sessionId);
    let output: unknown;

    const result = await runStep(
      ctx,
      session,
      async (current) => {
        const generated = await generateText({
          model,
          prompt: "Start the export.",
          tools: buildToolSet({ tools: new Map([[tool.name, tool]]) }),
        });
        output = generated.toolResults[0]?.output;
        return { next: null, session: current };
      },
      [backgroundToolExecutionProvider],
    );

    expect(isAuthorizationPendingModelOutput(output)).toBe(true);
    expect(result.backgroundTasks).toBeUndefined();
    expect(getSessionTaskIndex(result.session.state)).toEqual([]);
    expect(mocks.sendTaskCommand).not.toHaveBeenCalled();
    expect(mocks.rejectDelegatedDispatch).toHaveBeenCalledWith({
      error: {
        code: "PARENT_STEP_FAILED",
        message: "Background tool execution did not delegate or complete its task.",
      },
      task,
    });
  });
});
