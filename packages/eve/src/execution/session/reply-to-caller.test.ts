import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext, TurnCaller } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { replyToCaller } from "#execution/session/program.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  reportRefusedCallerReplyStep,
} from "#tasks/child.js";
import type { TaskRecord } from "#tasks/record.js";
import { encodeTaskCreator } from "#tasks/results.js";

vi.mock("#tasks/child.js", async (importOriginal) => ({
  ...(await importOriginal()),
  notifyCancelledTaskCallerStep: vi.fn(),
  notifyTurnCallerStep: vi.fn(),
  reportRefusedCallerReplyStep: vi.fn(),
}));

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "app",
  principalId: "alice",
  principalType: "user",
};
const CALLER: TurnCaller = {
  callId: "call-delegate",
  replyTo: { kind: "hook", token: "owner-inbox" },
  subagentName: "researcher",
};

function target(records: readonly TaskRecord[]) {
  const base = createTestSessionState({ sessionId: "child" });
  return {
    caller: CALLER,
    cursor: {
      serializedContext: { [AuthKey.name]: ALICE },
      sessionState: {
        ...base,
        snapshot: { session: { ...base.snapshot.session, state: taskTableState(records) } },
      },
    },
    sessionId: "child",
  };
}

function task(overrides: Partial<TaskRecord>): TaskRecord {
  return createTaskRecord({
    creator: encodeTaskCreator({ auth: ALICE }),
    id: "lookup-abc234",
    kind: "workflow",
    mode: "detached",
    name: "lookup",
    ...overrides,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("replyToCaller", () => {
  it("settles the caller once the turn's tasks are finished", async () => {
    await replyToCaller({
      ...target([task({ delivered: true, status: "completed" })]),
      reply: { kind: "settled", lifecycle: "parked", settled: { output: "Done." } },
    });

    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      lifecycle: "parked",
      sessionId: "child",
      settled: { output: "Done." },
    });
    expect(reportRefusedCallerReplyStep).not.toHaveBeenCalled();
  });

  it("refuses to settle a caller while tasks its turn started are working", async () => {
    const reply = { kind: "settled", lifecycle: "parked", settled: { output: "Early." } } as const;
    await replyToCaller({ ...target([task({})]), reply });
    await replyToCaller({ ...target([task({})]), reply: { kind: "cancelled" } });

    expect(notifyTurnCallerStep).not.toHaveBeenCalled();
    expect(notifyCancelledTaskCallerStep).not.toHaveBeenCalled();
    expect(reportRefusedCallerReplyStep).toHaveBeenCalledWith({
      callId: CALLER.callId,
      sessionId: "child",
      taskIds: ["lookup-abc234"],
    });
  });

  it("ignores attached calls, workflow-owned agents, and another principal's tasks", async () => {
    await replyToCaller({
      ...target([
        task({ id: "attached-abc234", mode: "attached" }),
        task({ id: "agent-abc234", workflowCaller: { replyTo: "hook", runId: "run-1" } }),
        task({
          creator: encodeTaskCreator({ auth: { ...ALICE, principalId: "bob" } }),
          id: "bob-abc234",
        }),
      ]),
      reply: { kind: "cancelled", usage: undefined },
    });

    expect(notifyCancelledTaskCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      sessionId: "child",
    });
    expect(reportRefusedCallerReplyStep).not.toHaveBeenCalled();
  });

  it("does nothing without a caller", async () => {
    await replyToCaller({
      ...target([task({})]),
      caller: undefined,
      reply: { kind: "cancelled" },
    });

    expect(reportRefusedCallerReplyStep).not.toHaveBeenCalled();
    expect(notifyCancelledTaskCallerStep).not.toHaveBeenCalled();
  });
});

describe("reportRefusedCallerReplyStep", () => {
  it("fails a test run so a refused reply surfaces", async () => {
    const actual = await vi.importActual<typeof import("#tasks/child.js")>("#tasks/child.js");

    await expect(
      actual.reportRefusedCallerReplyStep({
        callId: "call-delegate",
        sessionId: "child",
        taskIds: ["lookup-abc234"],
      }),
    ).rejects.toThrow(
      "Refused to settle caller call-delegate of session child while tasks lookup-abc234 are working.",
    );
  });
});
