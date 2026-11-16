import type { SessionEvent, SessionStreamEvent } from "eve/client";
import { emptySessionView, foldEvents, type JsonValue } from "eve/events";
import { describe, expect, it } from "vitest";
import {
  collectSubagentSessions,
  getSubagentStatus,
  getSubagentSubscriptionKey,
  getSubagentTask,
} from "./subagent-sessions";

describe("collectSubagentSessions", () => {
  it("joins the parent call outcome and keeps the latest call for a continued child", () => {
    const events = [
      ...requestedCall("call_1", { message: "First task" }),
      started("call_1", "task_1"),
      taskStarted("task_1", "call_1"),
      opened("child_1", { taskId: "task_1" }),
      ...requestedCall("call_2", { message: "Continued task" }),
      started("call_2", "task_1"),
      settled("call_2", "Done"),
    ];

    const sessions = collect(events);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.callId).toBe("call_2");
    expect(sessions[0]?.parentStatus).toBe("ready");
  });

  it("sorts the most recently opened children first", () => {
    const events = [
      opened("child_1", { callId: "call_1" }),
      opened("child_2", { callId: "call_2" }),
    ];

    expect(collect(events).map(({ childSessionId }) => childSessionId)).toEqual(
      ["child_2", "child_1"]
    );
  });

  it("uses the parent call's message without reading the child stream", () => {
    const [session] = collect([
      ...requestedCall("call_1", {
        message: "Task: Research nearby appointments\n\nFind a slot",
      }),
      opened("child_1", { callId: "call_1" }),
    ]);

    expect(session?.task).toBe("Research nearby appointments");
  });

  it("moves a continued child back to the front", () => {
    const events = [
      ...requestedCall("call_1", { message: "First" }),
      started("call_1", "task_1"),
      taskStarted("task_1", "call_1"),
      opened("child_1", { taskId: "task_1" }),
      ...requestedCall("call_2", { message: "Second" }),
      started("call_2", "task_2"),
      taskStarted("task_2", "call_2"),
      opened("child_2", { taskId: "task_2" }),
      ...requestedCall("call_3", { message: "Continue first" }),
      started("call_3", "task_1"),
    ];

    expect(collect(events).map(({ childSessionId }) => childSessionId)).toEqual(
      ["child_1", "child_2"]
    );
  });
});

describe("getSubagentSubscriptionKey", () => {
  it("changes when a continued child receives a new call", () => {
    const opening = [
      ...requestedCall("call_1", { message: "First" }),
      started("call_1", "task_1"),
      taskStarted("task_1", "call_1"),
      opened("child_1", { taskId: "task_1" }),
    ];
    const [first] = collect(opening);
    const [continued] = collect([
      ...opening,
      ...requestedCall("call_2", { message: "Continue" }),
      started("call_2", "task_1"),
    ]);
    if (!first || !continued) {
      throw new Error("Expected collected subagent sessions");
    }

    expect(getSubagentSubscriptionKey([continued])).not.toBe(
      getSubagentSubscriptionKey([first])
    );
  });
});

describe("getSubagentStatus", () => {
  it("uses the child stream instead of a running parent call", () => {
    const [session] = collect([
      ...requestedCall("call_1", { message: "Work" }),
      started("call_1", "task_1"),
      taskStarted("task_1", "call_1"),
      opened("child_1", { taskId: "task_1" }),
    ]);

    if (!session) throw new Error("Expected a collected subagent session");

    expect(getSubagentStatus([], session)).toBe("starting");
    expect(
      getSubagentStatus(
        [
          streamed({
            data: {
              cause: { deliveryId: "delivery_2" },
              follows: null,
              turnId: "turn_2",
            },
            scope: { turnId: "turn_2" },
            type: "turn.started",
          }),
        ],
        session
      )
    ).toBe("working");
  });

  it.each([
    [
      "failed",
      {
        error: { code: "failed", message: "Failed" },
        outcome: "failed",
        turnId: "turn_1",
      },
    ],
    ["cancelled", { outcome: "cancelled", turnId: "turn_1" }],
  ] as const)(
    "preserves a %s turn after its delivery settles",
    (expected, data) => {
      const [session] = collect([opened("child_1", { callId: "call_1" })]);
      if (!session) throw new Error("Expected a collected subagent session");
      const events = [
        streamed({ data, scope: { turnId: "turn_1" }, type: "turn.settled" }),
        streamed({
          data: {
            deliveryId: "delivery_1",
            outcome: "handled",
            turnId: "turn_1",
          },
          type: "delivery.settled",
        }),
      ];

      expect(getSubagentStatus(events, session)).toBe(expected);
    }
  );
});

describe("getSubagentTask", () => {
  it("keeps a concise original task after a child session is continued", () => {
    const events = [
      consumed("turn_1", "Task: First task\n\nFull assignment"),
      consumed("turn_2", "Continued task"),
    ];

    expect(getSubagentTask(events)).toBe("First task");
  });
});

function collect(events: readonly SessionStreamEvent[]) {
  return collectSubagentSessions(
    events,
    foldEvents(emptySessionView(), events)
  );
}

function requestedCall(callId: string, input: JsonValue) {
  const scope = { runId: `run_${callId}`, turnId: "turn_parent" };
  return [
    streamed({
      data: { owner: { turnId: scope.turnId }, runId: scope.runId },
      scope,
      type: "model.requested",
    }),
    streamed({
      data: {
        callId,
        capability: { kind: "tool", name: "run_browser" },
        input,
        owner: { runId: scope.runId },
      },
      scope,
      type: "call.requested",
    }),
  ];
}

function started(callId: string, taskId: string) {
  return streamed({
    data: { callId, taskId },
    scope: { turnId: "turn_parent" },
    type: "call.started",
  });
}

function settled(callId: string, output: JsonValue) {
  return streamed({
    data: { callId, outcome: "completed", output },
    scope: { turnId: "turn_parent" },
    type: "call.settled",
  });
}

function taskStarted(taskId: string, callId: string) {
  return streamed({
    data: { kind: "tool", name: "run_browser", startedBy: { callId }, taskId },
    scope: { turnId: "turn_parent" },
    type: "task.started",
  });
}

function opened(
  sessionId: string,
  owner: { readonly callId: string } | { readonly taskId: string }
) {
  return streamed({
    data: {
      name: "browser-agent",
      owner,
      sessionId,
      stream: `/eve/v1/session/${sessionId}/stream`,
    },
    scope: { turnId: "turn_parent" },
    type: "child.opened",
  });
}

function consumed(turnId: string, text: string) {
  return streamed({
    data: {
      deliveryId: `delivery_${turnId}`,
      parts: [{ kind: "text", text }],
      turnId,
    },
    scope: { turnId },
    type: "delivery.consumed",
  });
}

let nextLine = 0;

function streamed(fact: SessionEvent): SessionStreamEvent {
  const line = nextLine;
  nextLine += 1;
  return {
    ...fact,
    meta: {
      at: "2026-08-27T12:00:00.000Z",
      endOfLine: true,
      position: { index: 0, line },
    },
  };
}
