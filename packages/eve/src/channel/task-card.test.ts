import { describe, expect, it } from "vitest";

import {
  createActionResultEvent,
  createTaskActivityEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  type TaskActivityCall,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

import {
  AgentActivityFold,
  agentActivityEvent,
  taskCardView,
  trackTaskCardEvent,
  type TaskCardTurn,
} from "./task-card.js";

const AT = "2026-09-30T00:00:00.000Z";

function fold(events: readonly UnstampedMessageStreamEvent[]): TaskCardTurn {
  let turns: Readonly<Record<string, TaskCardTurn>> = {};
  for (const event of events) turns = { ...turns, ...trackTaskCardEvent(turns, event, AT) };
  return turns["turn-1"]!;
}

describe("task card", () => {
  it("shows a connection call as one row, not also its nested connection tool", () => {
    const turn = fold([
      {
        type: "actions.requested",
        data: {
          turnId: "turn-1",
          sequence: 0,
          stepIndex: 0,
          actions: [
            {
              kind: "tool-call",
              callId: "call-1",
              toolName: "connection_execute",
              input: { connection: "kennel", tool: "book_visit", input: {} },
            },
          ],
          presentation: { "call-1": { label: "kennel__book_visit" } },
        },
      },
      {
        type: "actions.requested",
        data: {
          turnId: "turn-1",
          sequence: 1,
          stepIndex: 0,
          actions: [
            {
              kind: "tool-call",
              callId: "call-1:nested",
              parentCallId: "call-1",
              toolName: "kennel__book_visit",
              input: {},
            },
          ],
        },
      },
      ...["call-1:nested", "call-1"].map((callId, index) =>
        createActionResultEvent({
          result: { kind: "tool-result", callId, toolName: "connection_execute", output: {} },
          sequence: 2 + index,
          stepIndex: 0,
          turnId: "turn-1",
        }),
      ),
    ]);

    const { actions } = taskCardView("turn-1", turn, { audience: "public" });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: "call-1", status: "completed" });
    expect(JSON.stringify(actions[0])).toContain("kennel__book_visit");
  });
});

describe("task activity", () => {
  it("reports an agent's calls as they change, settling a task call only when its task settles", () => {
    const agentEvents: UnstampedMessageStreamEvent[] = [
      {
        type: "actions.requested",
        data: {
          turnId: "agent-turn",
          sequence: 0,
          stepIndex: 0,
          actions: [
            { kind: "tool-call", callId: "lookup-1", toolName: "lookup", input: {} },
            { kind: "tool-call", callId: "brief-1", toolName: "researcher", input: {} },
            { kind: "tool-call", callId: "wait-1", toolName: "task_wait", input: {} },
          ],
          presentation: { "lookup-1": { label: "Reading the INC-2291 postmortem" } },
        },
      },
      createTaskStartedEvent({
        callId: "brief-1",
        kind: "agent",
        name: "researcher",
        taskId: "task-1",
        turnId: "agent-turn",
      }),
      // A task call's result is only its receipt.
      ...["brief-1", "lookup-1"].map((callId, index) =>
        createActionResultEvent({
          result: { kind: "tool-result", callId, toolName: "lookup", output: "ok" },
          sequence: 1 + index,
          stepIndex: 0,
          turnId: "agent-turn",
        }),
      ),
      createTaskSettledEvent({
        callId: "brief-1",
        error: { message: "No access." },
        kind: "agent",
        name: "researcher",
        status: "failed",
        taskId: "task-1",
        turnId: "agent-turn",
      }),
    ];

    const fold = new AgentActivityFold();
    const reports = agentEvents.map((event) => {
      const activity = agentActivityEvent(event);
      return activity === undefined ? [] : fold.apply(activity);
    });

    expect(reports).toEqual([
      [
        {
          id: "lookup-1",
          name: "lookup",
          status: "working",
          title: "Reading the INC-2291 postmortem",
        },
        { id: "brief-1", name: "researcher", status: "working", title: "Researcher" },
      ],
      [],
      [],
      [
        {
          id: "lookup-1",
          name: "lookup",
          status: "completed",
          title: "Reading the INC-2291 postmortem",
        },
      ],
      [{ id: "brief-1", name: "researcher", status: "failed", title: "Researcher" }],
    ]);
  });

  it("shows a task's newest agent calls on its row, through the task settling", () => {
    const call = (id: string, status: TaskActivityCall["status"]): TaskActivityCall => ({
      id,
      name: "lookup",
      status,
      title: `Looking up ${id}`,
    });
    const activity = (calls: TaskActivityCall[]) =>
      createTaskActivityEvent({ callId: "call-1", calls, taskId: "task-1", turnId: "turn-1" });
    const started = createTaskStartedEvent({
      callId: "call-1",
      kind: "agent",
      name: "researcher",
      taskId: "task-1",
      turnId: "turn-1",
    });

    const working = fold([
      started,
      activity([call("a", "working"), call("b", "working")]),
      activity([call("a", "completed")]),
    ]);
    expect(taskCardView("turn-1", working, { audience: "public" }).tasks[0]?.activity).toEqual({
      calls: [call("a", "completed"), call("b", "working")],
    });

    const ids = Array.from({ length: 12 }, (_, index) => `c${String(index)}`);
    const settled = fold([
      started,
      activity(ids.map((id) => call(id, "completed"))),
      createTaskSettledEvent({
        callId: "call-1",
        kind: "agent",
        name: "researcher",
        output: "Done.",
        status: "completed",
        taskId: "task-1",
        turnId: "turn-1",
      }),
    ]);
    expect(taskCardView("turn-1", settled, { audience: "public" }).tasks[0]?.activity).toEqual({
      calls: ids.slice(-10).map((id) => call(id, "completed")),
    });
  });
});
