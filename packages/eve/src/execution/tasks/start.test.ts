import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentStepAttempt } from "#execution/hosts.js";
import { sendToTask } from "#execution/tasks/start.js";
import {
  createTask,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
} from "#execution/tasks/table.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

vi.mock("#execution/hosts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/hosts.js")>()),
  currentStepAttempt: vi.fn(),
}));

function makeDirectTaskFixture(message: string) {
  const created = createTask(readTaskTable(undefined), {
    callId: "call-1",
    kind: "agent",
    name: "agent",
    resumable: true,
    turnId: "turn_0",
  });
  const table = recordTaskRun(created.table, created.taskId, {
    directAgent: {
      continuationToken: "subagent:parent:agent",
      name: "agent",
      nodeId: "agent",
    },
    hookToken: "eve:inbox:v1:eve:session:child-1:inbox",
    runId: "child-1",
  });
  const baseSession: HarnessSessionBase = {
    compaction: {},
    continuationToken: "http:parent",
    sessionId: "parent",
  };
  const session: HarnessSessionBase = writeTaskTable(baseSession, table);
  const view = storedProjection(undefined).view;
  const admissionView: SessionView = {
    ...view,
    session: { ...view.session, status: "open" },
    tasks: {
      [created.taskId]: {
        introducedAt: 0,
        kind: "agent",
        name: "agent",
        startedAt: "2026-01-01T00:00:00.000Z",
        startedBy: { callId: "call-1" },
        status: "running",
        taskId: created.taskId,
      },
    },
  };
  const command = vi.fn();
  const commandLate = vi.fn(async () => {});
  const start = vi.fn();
  return {
    admissionView,
    command,
    commandLate,
    input: {
      agentContext: {
        agents: {},
        bundle: { source: { kind: "bundled" as const } },
        dynamicSelections: {},
        parent: {
          callId: "call-2",
          rootSessionId: "parent",
          sessionId: "parent",
          turn: { id: "turn_0", sequence: 1 },
        },
        sandbox: { sessionId: "parent" },
        trace: { originAudience: "unknown" as const },
      },
      auth: { current: null, initiator: null },
      batchEvent: { sequence: 1, stepIndex: 1, turnId: "turn_0" },
      directAgents: { command, commandLate, start },
      directSendMaxAttempts: 4,
      owner: { inbox: "eve:inbox:v1:eve:session:parent:inbox" },
      parentSession: undefined,
      session,
      startRun: vi.fn(),
      task: {
        callId: "call-2",
        entry: { entryPoint: "receive" as const, taskId: created.taskId },
        input: { message, taskId: created.taskId },
        kind: "workflow-task" as const,
        toolName: "agent",
        workflowId: "workflow//eve//agentToolServeWorkflow",
      },
      taskId: created.taskId,
    },
    taskId: created.taskId,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("sendToTask direct local subagent retry handling", () => {
  it("rethrows transient TypeError fetch failures before the final attempt without resetting the child", async () => {
    vi.mocked(currentStepAttempt).mockReturnValue(1);
    const fixture = makeDirectTaskFixture("Follow up");
    const blip = new TypeError("fetch failed");
    fixture.command.mockRejectedValueOnce(blip);

    await expect(sendToTask(fixture.input, fixture.admissionView)).rejects.toBe(blip);
    expect(fixture.commandLate).not.toHaveBeenCalled();
  });

  it("converts transient TypeError fetch failures into a task failure on the final attempt", async () => {
    vi.mocked(currentStepAttempt).mockReturnValue(4);
    const fixture = makeDirectTaskFixture("Follow up");
    fixture.command.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await sendToTask(fixture.input, fixture.admissionView);

    expect(result.result.isError).toBe(true);
    expect(result.failedTask).toMatchObject({
      error: "fetch failed",
      taskId: fixture.taskId,
    });
    expect(fixture.commandLate).toHaveBeenCalledOnce();
  });

  it("fails immediately on attempt 1 when the follow-up message is empty or whitespace", async () => {
    vi.mocked(currentStepAttempt).mockReturnValue(1);
    const fixture = makeDirectTaskFixture("   ");

    const result = await sendToTask(fixture.input, fixture.admissionView);

    expect(fixture.command).not.toHaveBeenCalled();
    expect(result.result.isError).toBe(true);
    expect(result.failedTask).toMatchObject({ taskId: fixture.taskId });
    expect(fixture.commandLate).toHaveBeenCalledOnce();
  });
});
