import { describe, expect, it, vi } from "vitest";
import { handleWorkflowToolRunMessage } from "./turn-workflow-tool-run.js";
import { recordWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";

vi.mock("#execution/tools/subagent/task-cancel.js", () => ({
  cancelAgentInvocationOwnerStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  releaseAgentInvocationOwnerStep: vi.fn(async ({ sessionState }) => ({ sessionState })),
}));

describe("Code Mode outcomes in the parent", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "adopts tool state after a %s program",
    async (status) => {
      const cursor = createCursor();
      const result = await handleWorkflowToolRunMessage({
        cursor,
        callbackMetadataUrl: "https://example.com",
        message: {
          kind: "outcome",
          from: from(),
          result: {
            status,
            output: "answer",
            error: "failed",
            reason: "stop",
            stateChanges: [{ path: ["serializedContext", "todo"], before: "old", after: "new" }],
          },
        },
      });
      expect(cursor.serializedContext).toEqual({ todo: "new", parentOnly: "keep" });
      expect(result).not.toHaveProperty("stateChanges");
      expect(result).toMatchObject({ kind: "tool-result", toolName: "code_mode" });
    },
  );

  it("rejects stale outcomes and preserves newer parent edits on conflict", async () => {
    const cursor = createCursor();
    const message = {
      kind: "outcome" as const,
      from: from(),
      result: {
        status: "completed" as const,
        output: "answer",
        stateChanges: [{ path: ["serializedContext", "todo"], before: "stale", after: "new" }],
      },
    };
    expect(
      await handleWorkflowToolRunMessage({
        cursor,
        callbackMetadataUrl: "https://example.com",
        message: { ...message, from: { ...message.from, runId: "wrong" } },
      }),
    ).toBeUndefined();
    const result = await handleWorkflowToolRunMessage({
      cursor,
      callbackMetadataUrl: "https://example.com",
      message,
    });
    expect(result).toMatchObject({
      isError: true,
      output: expect.stringContaining("CODE_MODE_STATE_CONFLICT"),
    });
    expect(cursor.serializedContext.todo).toBe("old");
  });
});

function from() {
  return {
    callId: "call",
    execution: "blocking" as const,
    input: {},
    runId: "run",
    sequence: 1,
    stepIndex: 0,
    toolName: "code_mode",
    turnId: "turn",
  };
}

function createCursor(): TurnExecutionCursor {
  const session = recordWorkflowToolRun(
    {
      agent: { dynamicModel: true as const, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10_000 },
      continuationToken: "token",
      history: [],
      sessionId: "session",
      state: {},
    },
    {
      callId: "call",
      hookToken: "hook",
      runId: "run",
      toolName: "code_mode",
    },
  );
  return new TurnExecutionCursor({
    controlToken: "control",
    parentWritable: new WritableStream(),
    serializedContext: { todo: "old", parentOnly: "keep" },
    sessionState: createDurableSessionState({ session }),
  });
}
