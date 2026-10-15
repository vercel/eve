import { expect, it } from "vitest";

import { commitCallEntry } from "#execution/tasks/model-step.js";
import { readTaskTable } from "#execution/tasks/table.js";
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
