import { jsonSchema, type TextStreamPart, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { appendTaskContext, commitCallEntry } from "#execution/tasks/model-step.js";
import { readTaskTable, writeTaskTable } from "#execution/tasks/table.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { toolModelOutputContext } from "#harness/tool-model-output.js";
import { emitStreamContent } from "#harness/emission.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { HarnessSession } from "#harness/types.js";
import { subagentTool } from "#internal/testing/catalog-fixtures.js";

const session: HarnessSession = {
  compaction: {},
  continuationToken: "http:test-session",
  history: [],
  sessionId: "test-session",
};

it.each(["", "undefined", "null"])(
  "starts a new task for an agent call whose taskId is %j",
  (taskId) => {
    const committed = commitCallEntry(session, {
      callId: "call-1",
      definition: subagentTool("researcher"),
      input: { message: "Find the March incidents.", taskId },
      toolName: "researcher",
      turnId: "turn_0",
    });

    const [task] = readTaskTable(committed.session.state).tasks;
    expect(committed.entry).toEqual({ entryPoint: "serve", taskId: task?.id });
    expect(committed.input).toEqual({ message: "Find the March incidents." });
  },
);

describe("text beside a task wait", () => {
  it.each([
    { finalReplyOnly: false, phase: "reply", streamedInput: true },
    { finalReplyOnly: true, phase: "narration", streamedInput: true },
    { finalReplyOnly: false, phase: "reply", streamedInput: false },
    { finalReplyOnly: true, phase: "narration", streamedInput: false },
  ])(
    "publishes $phase with finalReplyOnly=$finalReplyOnly and streamedInput=$streamedInput",
    async ({ finalReplyOnly, phase, streamedInput }) => {
      const events: SessionEvent[] = [];
      async function* stream() {
        yield* [
          { id: "message-1", text: "Alice's report is underway.", type: "text-delta" },
          ...(streamedInput
            ? [
                { id: "call-wait", toolName: "eve__task_wait", type: "tool-input-start" },
                { delta: "{}", id: "call-wait", type: "tool-input-delta" },
                { id: "call-wait", type: "tool-input-end" },
              ]
            : []),
          { input: {}, toolCallId: "call-wait", toolName: "eve__task_wait", type: "tool-call" },
          { finishReason: "tool-calls", type: "finish-step" },
        ] as TextStreamPart<ToolSet>[];
      }

      await emitStreamContent(
        eachEvent(async (event) => {
          events.push(event);
        }),
        { runId: "run_0", sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
        stream(),
        {
          excludedActionToolNames: new Set(),
          finalReplyOnly,
          sessionCall: () => undefined,
          tools: new Map(),
        },
      );

      expect(events.filter((event) => event.type === "content.completed")).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            kind: "text",
            phase,
            runId: "run_0",
            value: "Alice's report is underway.",
          }),
          type: "content.completed",
        }),
      ]);
      expect(events.findIndex((event) => event.type === "content.completed")).toBeLessThan(
        events.findIndex((event) => event.type === "call.requested"),
      );
    },
  );
});

describe("task results projected by toModelOutput", () => {
  it("gives each reply of a resumable task its own call id", async () => {
    const calls = (callId: string) => [{ callId, turnId: "turn_0" }];
    const table = writeTaskTable(session, {
      tasks: [
        {
          calls: [],
          id: "lookup-1",
          kind: "tool",
          name: "lookup",
          results: [
            { calls: calls("call-a"), output: "first", status: "completed" },
            { calls: calls("call-b"), output: "second", status: "completed" },
          ],
          resumable: true,
        },
      ],
    });
    const seen: string[] = [];
    const definition: HarnessToolDefinition = {
      description: "lookup",
      inputSchema: jsonSchema({ type: "object" }),
      name: "lookup",
      toModelOutput: (output, ctx) => {
        seen.push(ctx.callId);
        return { type: "text", value: String(output) };
      },
    };

    await appendTaskContext({
      messages: [],
      outputContext: toolModelOutputContext,
      session: table,
      tools: new Map([["lookup", definition]]),
    });

    expect(seen).toEqual(["call-a", "call-b"]);
  });
});
