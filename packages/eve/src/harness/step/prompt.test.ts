import { expect, it, vi } from "vitest";

import {
  createTask,
  readTaskTable,
  settleTaskCalls,
  writeTaskTable,
} from "#execution/tasks/table.js";
import { createUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";
import type { Step } from "./context.js";
import type { TurnInput } from "./intake.js";
import { commitTurnInput, previewPrompt } from "./prompt.js";

vi.mock("#definitions/step.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#definitions/step.js")>()),
  stepCatalog: async () => new Map(),
}));

/** A session whose background task has a result the next model call delivers. */
function stepWithTaskResult(): Step {
  const history: HarnessModelMessage[] = [
    createUserMessage("user", "Did QA pass?"),
    { content: "QA is still being checked.", role: "assistant" },
  ];
  const created = createTask(readTaskTable(undefined), {
    callId: "call-1",
    kind: "agent",
    name: "agent",
    resumable: false,
    turnId: "turn-1",
  });
  const { table } = settleTaskCalls(created.table, {
    callIds: ["call-1"],
    outcome: { output: "QA passed.", status: "completed" },
    taskId: created.taskId,
  });
  const session = writeTaskTable({ history } as Partial<HarnessSession> as HarnessSession, table);
  return { session } as Partial<Step> as Step;
}

const turn: TurnInput = {
  clientContext: undefined,
  ephemeral: [],
  hasUserMessage: false,
  message: undefined,
  messages: [],
  storedClientContext: undefined,
  turnId: "turn-2",
};

it("previews the task results the model call reads without delivering them", async () => {
  const step = stepWithTaskResult();
  const before = step.session;

  const preview = await previewPrompt(step, turn);

  expect(JSON.stringify(preview.messages)).toContain("<task_result id=");
  expect(JSON.stringify(preview.messages)).toContain("QA passed.");
  expect(step.session).toBe(before);
  const committed = await commitTurnInput(step, turn);
  expect(committed.messages).toEqual(preview.messages);
});
