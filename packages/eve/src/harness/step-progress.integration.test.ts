import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { contextStorage } from "#context/container.js";
import { runModelCallBatch } from "#execution/model-call-batching.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import {
  createTask,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
} from "#execution/tasks/table.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallStreamResult,
  usage,
} from "#internal/testing/approval-resume.js";
import { createProjectionRecorder } from "#internal/testing/session-projection-recorder.js";
import { eachEvent } from "#internal/testing/session-machine.js";

vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

function fixture(model: MockLanguageModelV4, tools: readonly HarnessToolDefinition[]) {
  const recorder = createProjectionRecorder();
  const harness = createToolLoopHarness({
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    resolveModel: async () => model,
    handleEvent: eachEvent(async (event) => recorder.record(event)),
  });
  const session: HarnessSession = {
    agent: {
      modelReference: { id: model.modelId },
      system: "Help Alice finish her work.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:step-progress",
    sessionId: "step-progress",
    history: [],
  };
  return {
    session,
    run: (initialSession: HarnessSession) =>
      runModelCallBatch({
        initialSession,
        initialInput: { message: "Please finish Alice's work." },
        modelCallsPerStep: 3,
        runStep: ({ session, stepInput }) =>
          contextStorage.run(recorder.enter(createApprovalContext()), () =>
            harness(session, stepInput),
          ),
      }),
  };
}

describe("model step progress", () => {
  it("waits for background work after an endsTurn call instead of reading its tool result again", async () => {
    const stream = vi.fn(async () =>
      toolCallStreamResult({ toolName: "finish", toolCallId: "finish-call", input: "{}" }),
    );
    const model = new MockLanguageModelV4({
      doStream: stream,
      modelId: "ends-turn",
      provider: "eve-test",
    });
    const app = fixture(model, [
      {
        name: "finish",
        description: "Finish Alice's current action.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => "finished",
        endsTurn: true,
      },
    ]);
    const task = createTask(readTaskTable(undefined), {
      callId: "research-call",
      kind: "agent",
      name: "research",
      resumable: false,
      turnId: "turn_0",
    });
    const session = writeTaskTable(
      app.session,
      recordTaskRun(task.table, task.taskId, {
        runId: "research-run",
        hookToken: "research-control",
      }),
    );

    const result = await app.run(session);

    expect(stream).toHaveBeenCalledOnce();
    expect(resolveSessionStepResult(result, {})).toMatchObject({
      action: "paused",
      on: "tasks",
      taskIds: [task.taskId],
    });
  });

  it("continues after a provider result followed only by reasoning", async () => {
    const execute = vi.fn(() => {
      throw new Error("A provider's call must not run locally.");
    });
    const stream = vi
      .fn()
      .mockResolvedValueOnce({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolName: "search",
              toolCallId: "provider-search",
              input: "{}",
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolName: "search",
              toolCallId: "provider-search",
              result: { found: true },
            },
            { type: "reasoning-start", id: "reasoning" },
            {
              type: "reasoning-delta",
              id: "reasoning",
              delta: "Prepare Alice's answer from the result.",
            },
            { type: "reasoning-end", id: "reasoning" },
            { type: "finish", finishReason: { raw: undefined, unified: "stop" }, usage },
          ] satisfies LanguageModelV4StreamPart[],
        }),
      })
      .mockResolvedValue(textStreamResult("Alice's answer is ready."));
    const model = new MockLanguageModelV4({
      doStream: stream,
      modelId: "provider-result",
      provider: "eve-test",
    });
    const app = fixture(model, [
      {
        name: "search",
        description: "Search for Alice.",
        inputSchema: jsonSchema({ type: "object" }),
        execute,
      },
    ]);

    const result = await app.run(app.session);

    expect(stream).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(resolveSessionStepResult(result, {})).toMatchObject({
      action: "parked",
      settled: { output: "Alice's answer is ready." },
    });
  });
});
