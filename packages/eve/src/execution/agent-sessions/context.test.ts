import { describe, expect, it } from "vitest";

import { resolveStepAgentLimits } from "#execution/agent-sessions/context.js";
import {
  createTask,
  readTaskTable,
  writeTaskTable,
  type TaskTable,
} from "#execution/tasks/table.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest, WorkflowToolCallEntry } from "#shared/action-types.js";

/** Alice's session has spent 400 of 1,000 input tokens and $0.50 of $2.00. */
function aliceSession(table: TaskTable): HarnessSession {
  const used = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.5,
    inputTokens: 400,
    outputTokens: 0,
    sawCost: true,
  };
  const session = {
    limits: { maxInputTokensPerSession: 1_000, maxTokenCostUsdPerSession: 2 },
    sessionId: "alice-session",
  } as HarnessSession;
  return setTurnUsageState(writeTaskTable(session, table), {
    ...used,
    session: used,
    turnId: "turn_1",
  });
}

function call(callId: string, entry: WorkflowToolCallEntry): RuntimeWorkflowTaskRequest {
  return { callId, entry, input: {}, kind: "workflow-task", toolName: callId, workflowId: callId };
}

function task(
  table: TaskTable,
  name: string,
  kind: "agent" | "tool",
): { readonly table: TaskTable; readonly taskId: string } {
  return createTask(table, { callId: name, kind, name, resumable: true, turnId: "turn_1" });
}

/**
 * One model step's calls: the step started a reviewer and a writer agent
 * task, an authored `serve` task, and an `execute` call, and sent a message
 * to a planner agent task an earlier step started.
 */
function stepCalls(input: { readonly startsAgents: boolean }): {
  readonly plan: readonly RuntimeWorkflowTaskRequest[];
  readonly table: TaskTable;
} {
  const planner = task(readTaskTable(undefined), "planner", "agent");
  const plan = [
    call("research", { entryPoint: "execute" }),
    call("planner", { entryPoint: "receive", taskId: planner.taskId }),
  ];
  if (!input.startsAgents) return { plan, table: planner.table };
  const reviewer = task(planner.table, "reviewer", "agent");
  const writer = task(reviewer.table, "writer", "agent");
  const notes = task(writer.table, "notes", "tool");
  return {
    plan: [
      ...plan,
      call("reviewer", { entryPoint: "serve", taskId: reviewer.taskId }),
      call("writer", { entryPoint: "serve", taskId: writer.taskId }),
      call("notes", { entryPoint: "serve", taskId: notes.taskId }),
    ],
    table: notes.table,
  };
}

describe("resolveStepAgentLimits", () => {
  it.each([
    { expected: { input: 300, costUsd: 0.75 }, startsAgents: true },
    { expected: { input: 600, costUsd: 1.5 }, startsAgents: false },
  ])(
    "splits the remainder across the agent tasks a step starts (starts agents: $startsAgents)",
    ({ expected, startsAgents }) => {
      const { plan, table } = stepCalls({ startsAgents });

      expect(resolveStepAgentLimits({ plan, session: aliceSession(table) })).toEqual({
        maxInputTokensPerSession: expected.input,
        maxOutputTokensPerSession: false,
        maxTokenCostUsdPerSession: expected.costUsd,
      });
    },
  );
});
