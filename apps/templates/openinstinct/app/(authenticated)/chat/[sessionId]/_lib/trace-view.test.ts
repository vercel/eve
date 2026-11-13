import type { SessionEvent, SessionStreamEvent } from "eve/client";
import { emptySessionView, foldEvents, type JsonValue } from "eve/events";
import type { EveMessage } from "eve/react";
import { describe, expect, it } from "vitest";
import {
  backgroundWorkerDeliveryMessageIds,
  messagesForTraceView,
} from "./trace-view";

describe("trace view", () => {
  it("keeps ordinary delivered text and its report visible", () => {
    const events = receivedMessage("task-delivery", "A cohort completed.");
    const messages = [
      userMessage("task-delivery", "A cohort completed."),
      assistantMessage("task-delivery", "Here is the result."),
    ];
    expect(
      messagesForTraceView(messages, events, viewOf(events), "imessage")
    ).toEqual(messages);
  });

  it.each([
    ["update", "update: Checking availability", false],
    ["input", "needs input.", false],
    ["cancelled", "is cancelled.", true],
    [
      "completed",
      'is completed.\n\nResult:\n{"status":"success","message":"Done"}',
      false,
    ],
    ["failed", 'failed.\n\nError:\n{"message":"Worker failed"}', false],
  ])(
    "identifies a worker task %s delivery",
    (_label, notification, hidesResponse) => {
      const events = [
        ...workerReceipt("task_worker"),
        ...(hidesResponse ? workerCancellationResult("task_worker") : []),
        ...receivedMessage(
          "task-delivery",
          `Background task task_worker (browser-agent) ${notification}`
        ),
      ];

      expect(
        backgroundWorkerDeliveryMessageIds(events, viewOf(events))
      ).toEqual(
        new Set([
          "task-delivery:user",
          ...(hidesResponse ? ["task-delivery:assistant"] : []),
        ])
      );
    }
  );

  it("identifies authorization delivery for a known worker task", () => {
    const events = [
      ...workerReceipt("task_worker"),
      ...receivedMessage(
        "task-delivery",
        "Background task task_worker needs authorization."
      ),
    ];

    expect(backgroundWorkerDeliveryMessageIds(events, viewOf(events))).toEqual(
      new Set(["task-delivery:user"])
    );
  });

  it("hides task deliveries only in the iMessage projection", () => {
    const deliveryText =
      "Background task task_worker (browser-agent) is cancelled.";
    const ordinaryText =
      "Background task task_someone_else (browser-agent) is cancelled.";
    const events = [
      ...workerReceipt("task_worker"),
      ...workerCancellationResult("task_worker"),
      ...receivedMessage("task-delivery", deliveryText),
      ...receivedMessage("ordinary-user-message", ordinaryText),
    ];
    const view = viewOf(events);
    const messages = [
      userMessage("task-delivery", deliveryText),
      userMessage("ordinary-user-message", ordinaryText),
      assistantMessage("task-delivery", "Here is the useful result."),
    ];

    expect(messagesForTraceView(messages, events, view, "imessage")).toEqual([
      messages[1],
    ]);
    expect(messagesForTraceView(messages, events, view, "trace")).toBe(
      messages
    );
  });

  it("keeps identical user-authored cancellation text visible", () => {
    const text = "Background task task_worker (browser-agent) is cancelled.";
    const events = [
      ...workerReceipt("task_worker"),
      ...receivedMessage("user-spoof", text),
      ...workerCancellationResult("task_worker"),
      ...receivedMessage("framework-delivery", text),
    ];
    const messages = [
      userMessage("user-spoof", text),
      assistantMessage("user-spoof", "Visible reply"),
      userMessage("framework-delivery", text),
      assistantMessage("framework-delivery", "Hidden redundant reply"),
    ];

    expect(
      messagesForTraceView(messages, events, viewOf(events), "imessage")
    ).toEqual(messages.slice(0, 2));
  });
});

/** A legacy browser worker receipt, as saved v26 streams read back in v27. */
function workerReceipt(taskId: string) {
  return settledCall("call_worker", "agent", "browser-agent", {
    agentId: "agent_worker",
    status: "working",
    taskId,
  });
}

function workerCancellationResult(taskId: string) {
  return settledCall("call_cancel", "tool", "task_cancel", {
    tasks: [
      {
        metadata: {
          agentId: "agent_worker",
          kind: "subagent",
          mode: "local",
          name: "browser-agent",
        },
        status: "cancelled",
        taskId,
      },
    ],
  });
}

function settledCall(
  callId: string,
  kind: "agent" | "tool",
  name: string,
  output: JsonValue
) {
  const scope = { runId: `run_${callId}`, turnId: `turn_${callId}` };
  return [
    streamed({
      data: { owner: { turnId: scope.turnId }, runId: scope.runId },
      scope,
      type: "model.requested",
    }),
    streamed({
      data: {
        callId,
        capability: { kind, name },
        input: {},
        owner: { runId: scope.runId },
      },
      scope,
      type: "call.requested",
    }),
    streamed({
      data: { callId, outcome: "completed", output },
      scope,
      type: "call.settled",
    }),
  ];
}

function receivedMessage(name: string, text: string) {
  return [
    streamed({
      data: {
        deliveryId: name,
        parts: [{ kind: "text", text }],
        turnId: name,
      },
      scope: { turnId: name },
      type: "delivery.consumed",
    }),
  ];
}

let nextLine = 0;

function streamed(fact: SessionEvent): SessionStreamEvent {
  const line = nextLine;
  nextLine += 1;
  return {
    ...fact,
    meta: {
      at: "2026-08-27T20:00:00.000Z",
      endOfLine: true,
      position: { index: 0, line },
    },
  };
}

function viewOf(events: readonly SessionStreamEvent[]) {
  return foldEvents(emptySessionView(), events);
}

function userMessage(name: string, text: string): EveMessage {
  return {
    id: `${name}:user`,
    metadata: { status: "complete", turnId: name },
    parts: [{ state: "done", text, type: "text" }],
    role: "user",
  };
}

function assistantMessage(name: string, text: string): EveMessage {
  return {
    id: `${name}:assistant`,
    metadata: { status: "complete", turnId: name },
    parts: [{ state: "done", stepIndex: 0, text, type: "text" }],
    role: "assistant",
  };
}
