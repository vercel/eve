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
import { isAuthorizationPendingModelOutput, requestAuthorization } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessSession } from "#harness/types.js";
import { defineTool, type TaskExec, type ToolContext } from "#public/definitions/tool.js";
import { toInputSchema } from "#shared/tool-schema.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

const mocks = vi.hoisted(() => ({
  beginBackgroundTask: vi.fn(),
  rejectDelegatedDispatch: vi.fn(),
  sendTaskCommand: vi.fn(),
}));

vi.mock("#execution/tasks/parent/delegate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/delegate.js")>()),
  beginBackgroundTask: mocks.beginBackgroundTask,
  rejectDelegatedDispatch: mocks.rejectDelegatedDispatch,
}));
vi.mock("#execution/tasks/parent/run-parent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/run-parent.js")>()),
  sendTaskCommand: mocks.sendTaskCommand,
}));

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

describe("background tool execution", () => {
  beforeEach(() => {
    mocks.beginBackgroundTask.mockReset();
    mocks.rejectDelegatedDispatch.mockReset();
    mocks.sendTaskCommand.mockReset();
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

  it("rolls back generic executor effects when the parent step fails", async () => {
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
    const rollback = vi.fn();
    const definition = defineTool({
      description: "Start an external export.",
      execution: "background",
      inputSchema: z.strictObject({ query: z.string() }),
      execute(input: { readonly query: string }, _ctx: ToolContext, background: TaskExec) {
        background.stageEffect({
          apply: (session) => ({ ...session, state: { ...session.state, export: input.query } }),
          rollback,
        });
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

    expect(rollback).toHaveBeenCalledWith(
      expect.objectContaining({ message: "parent step failed" }),
    );
    expect(mocks.rejectDelegatedDispatch).toHaveBeenCalledWith({
      error: { code: "PARENT_STEP_FAILED", message: "parent step failed" },
      task: {
        ...task,
        executor: { data: { exportId: "customers" }, kind: "export" },
      },
    });
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
