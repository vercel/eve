import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { commitCallEntry, taskSystemMessages } from "#execution/tasks/model-step.js";
import { readTaskTable } from "#execution/tasks/table.js";
import { emitStreamContent } from "#harness/emission.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { HarnessSession } from "#harness/types.js";
import { subagentTool } from "#internal/testing/catalog-fixtures.js";

const session: HarnessSession = {
  agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 100_000 },
  continuationToken: "http:test-session",
  history: [],
  sessionId: "test-session",
};

// Some models fill an optional string with "" instead of omitting it (#4819).
it("starts a new task for an agent call whose taskId is empty", () => {
  const committed = commitCallEntry(session, {
    callId: "call-1",
    definition: subagentTool("researcher"),
    input: { message: "Find the March incidents.", taskId: "" },
    toolName: "researcher",
    turnId: "turn_0",
  });

  const [task] = readTaskTable(committed.session.state).tasks;
  expect(committed.entry).toEqual({ entryPoint: "serve", taskId: task?.id });
  expect(committed.input).toEqual({ message: "Find the March incidents." });
});

import { FINAL_REPLY_TASK_SYSTEM_BLOCK, TASK_SYSTEM_BLOCK } from "#execution/tasks/render.js";

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

describe("taskSystemMessages", () => {
  it("lets a person hear that work is underway, and has a child or schedule wait instead", () => {
    expect(taskSystemMessages(true, false)).toEqual([
      { content: TASK_SYSTEM_BLOCK, role: "system" },
    ]);
    expect(taskSystemMessages(true, true)).toEqual([
      { content: FINAL_REPLY_TASK_SYSTEM_BLOCK, role: "system" },
    ]);
    expect(TASK_SYSTEM_BLOCK).toContain("If the person should hear from you now");
    expect(FINAL_REPLY_TASK_SYSTEM_BLOCK).toContain("Only your final reply reaches your caller");
  });

  it("says nothing about tasks when the session offers none", () => {
    expect(taskSystemMessages(false, false)).toEqual([]);
  });
});
