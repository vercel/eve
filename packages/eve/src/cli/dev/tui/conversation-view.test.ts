import { describe, expect, it } from "vitest";

import { Conversation } from "#client/conversation.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";

import { tuiSessionData } from "./conversation-view.js";

const usage = (inputTokens: number) => ({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens,
  outputTokens: 1,
});

function turn(turnId: string, runId: string, follows: string | null = null): SessionEvent[] {
  return [
    { data: { cause: { deliveryId: `d_${turnId}` }, follows, turnId }, type: "turn.started" },
    { data: { owner: { turnId }, runId }, type: "model.requested" },
    {
      data: { attempt: 0, modelId: "\u001b[31mopenai/gpt\n5\u001b[0m", runId },
      type: "model.started",
    },
  ];
}

function call(callId: string, runId: string, label?: string): SessionEvent {
  return {
    data: {
      callId,
      capability: { kind: "tool", name: "search", ...(label !== undefined && { label }) },
      input: {},
      owner: { runId },
    },
    type: "call.requested",
  };
}

function read(events: readonly SessionEvent[]) {
  const conversation = new Conversation();
  events.forEach((event, index) => conversation.observe(stampTestEvent(event, index)));
  return tuiSessionData(conversation.state);
}

describe("tuiSessionData", () => {
  it("reads usage, the latest turn's model, labels, and withdrawn calls from the tables", () => {
    const data = read([
      { data: {}, type: "session.started" },
      ...turn("turn_1", "run_1"),
      {
        data: { kind: "model", owner: { runId: "run_1" }, usage: usage(10) },
        type: "usage.recorded",
      },
      call("call_1", "run_1", "Searching"),
      { data: { callId: "call_1", outcome: "completed", label: "Searched" }, type: "call.settled" },
      call("call_2", "run_1"),
      {
        data: { callId: "call_2", cause: { policy: "task-limit" }, outcome: "rejected" },
        type: "call.settled",
      },
      call("call_3", "run_1", "Looking"),
      { data: { callId: "call_3", output: {}, label: "Reading page 2" }, type: "call.progress" },
      { data: { owner: { turnId: "turn_1" }, runId: "run_2" }, type: "model.requested" },
      {
        data: { kind: "model", owner: { runId: "run_2" }, usage: usage(25) },
        type: "usage.recorded",
      },
    ]);

    expect(data.usage).toEqual({ inputTokens: 35, outputTokens: 2 });
    expect(data.lastStepUsage?.inputTokens).toBe(25);
    expect(data.modelId).toBe("openai/gpt 5");
    expect(data.toolLabels("call_1")).toEqual({ complete: "Searched", start: "Searching" });
    expect(data.toolLabels("call_2")).toBeUndefined();
    expect(data.toolLabels("call_3")).toEqual({ start: "Reading page 2" });
    expect(data.withdrawn("call_2")).toBe(true);
    expect(data.withdrawn("call_1")).toBe(false);
  });

  it("lists each failure once, without the session's repeat of its turn's", () => {
    const error = { code: "MODEL_FAILED", message: "The model failed." };
    const data = read([
      { data: {}, type: "session.started" },
      ...turn("turn_1", "run_1"),
      { data: { error, outcome: "failed", turnId: "turn_1" }, type: "turn.settled" },
      ...turn("turn_2", "run_2", "turn_1"),
      { data: { error, outcome: "failed", turnId: "turn_2" }, type: "turn.settled" },
      { data: { cause: { turnId: "turn_2" }, error, outcome: "failed" }, type: "session.ended" },
    ]);

    expect(data.failures).toEqual([
      { error, turnId: "turn_1" },
      { error, turnId: "turn_2" },
    ]);
    expect(data.sessionFailed).toBe(true);
  });

  it("uses model and context usage from the selected conversation", () => {
    const first = turn("turn_1", "run_1");
    const second = turn("turn_2", "run_2", "turn_1").map((event) =>
      event.type === "model.started"
        ? { ...event, data: { ...event.data, modelId: "other/model" } }
        : event,
    );
    const events: SessionEvent[] = [
      { data: {}, type: "session.started" },
      ...first,
      {
        data: { kind: "model", owner: { runId: "run_1" }, usage: usage(10) },
        type: "usage.recorded",
      },
      { data: { outcome: "completed", turnId: "turn_1" }, type: "turn.settled" },
      ...second,
      {
        data: { kind: "model", owner: { runId: "run_2" }, usage: usage(25) },
        type: "usage.recorded",
      },
      { data: { outcome: "completed", turnId: "turn_2" }, type: "turn.settled" },
      { type: "context.started", data: { changeId: "change_1", kind: "rewind" } },
      {
        type: "context.settled",
        data: {
          changeId: "change_1",
          kind: "rewind",
          outcome: "completed",
          selects: { turnId: "turn_1" },
        },
      },
    ];
    const data = read(events);
    expect(data.modelId).toBe("openai/gpt 5");
    expect(data.lastStepUsage?.inputTokens).toBe(10);
    expect(data.usage.inputTokens).toBe(35);
  });

  it("hides failures from turns excluded by rewind and clear", () => {
    const error = { code: "MODEL_FAILED", message: "The model failed." };
    const events: SessionEvent[] = [
      { data: {}, type: "session.started" },
      ...turn("turn_1", "run_1"),
      { data: { outcome: "completed", turnId: "turn_1" }, type: "turn.settled" },
      ...turn("turn_2", "run_2", "turn_1"),
      { data: { error, outcome: "failed", turnId: "turn_2" }, type: "turn.settled" },
    ];
    const settled = (selects: null | { turnId: string }): SessionEvent => ({
      type: "context.settled",
      data: { changeId: "change_1", kind: "rewind", outcome: "completed", selects },
    });
    const started: SessionEvent = {
      type: "context.started",
      data: { changeId: "change_1", kind: "rewind" },
    };
    expect(read(events).failures).toEqual([{ error, turnId: "turn_2" }]);
    expect(read([...events, started, settled({ turnId: "turn_1" })]).failures).toEqual([]);
    expect(read([...events, started, settled(null)]).failures).toEqual([]);
  });

  it("reads a failed session's error as the failure of the turn it cancelled", () => {
    const error = { code: "MODEL_FAILED", message: "The model failed." };
    const data = read([
      { data: {}, type: "session.started" },
      ...turn("turn_1", "run_1"),
      { data: { outcome: "cancelled", turnId: "turn_1" }, type: "turn.settled" },
      { data: { cause: { turnId: "turn_1" }, error, outcome: "failed" }, type: "session.ended" },
    ]);

    expect(data.failures).toEqual([{ error, turnId: "turn_1" }]);
  });
});
