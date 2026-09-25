import { describe, expect, it } from "vitest";

import type {
  MessageCompletedStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";

import { collectTurnEvents, summarizeTurnEvents, TurnEndTracker } from "./session-utils.js";

const eventData = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

describe("summarizeTurnEvents", () => {
  it("projects the complete waiting-turn lifecycle in one pass", () => {
    const request = {
      action: { callId: "call_1", input: {}, kind: "tool-call" as const, toolName: "bash" },
      kind: "tool-approval" as const,
      display: "confirmation" as const,
      options: [{ id: "approve", label: "Approve" }],
      prompt: "Approve?",
      requestId: "request_1",
    };
    const events = [
      {
        type: "message.completed",
        data: {
          finishReason: "stop",
          message: "Working on it",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "input.requested", data: { ...eventData, requests: [request] } },
      {
        type: "authorization.required",
        data: { ...eventData, description: "Sign in", name: "linear", webhookUrl: "https://auth" },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ] satisfies UnstampedMessageStreamEvent[];

    expect(summarizeTurnEvents(events)).toMatchObject({
      boundary: { type: "session.waiting" },
      inputRequests: [request],
      message: "Working on it",
      pendingAuthorizations: [
        { description: "Sign in", name: "linear", webhookUrl: "https://auth" },
      ],
      status: "waiting",
    });
  });

  it("removes completed authorizations and retains the final turn failure", () => {
    const events = [
      {
        type: "authorization.required",
        data: { ...eventData, description: "Sign in", name: "linear" },
      },
      {
        type: "authorization.completed",
        data: { ...eventData, name: "linear", outcome: "authorized" },
      },
      {
        type: "turn.failed",
        data: { code: "provider_error", message: "Unavailable", sequence: 2, turnId: "turn_1" },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ] satisfies UnstampedMessageStreamEvent[];

    expect(summarizeTurnEvents(events)).toMatchObject({
      failure: { type: "turn.failed", data: { message: "Unavailable" } },
      pendingAuthorizations: [],
      status: "waiting",
    });
  });
});

describe("collectTurnEvents", () => {
  it("stops at the current-turn boundary", async () => {
    async function* stream(): AsyncGenerator<UnstampedMessageStreamEvent> {
      yield {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      };
      yield { type: "session.completed" };
    }

    await expect(collectTurnEvents(stream())).resolves.toEqual([
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ]);
  });
});

const WAITING = {
  type: "session.waiting",
  data: { continuationToken: "session-id", wait: "next-user-message" },
} satisfies UnstampedMessageStreamEvent;

function reply(message: string, interim = false): UnstampedMessageStreamEvent {
  const data: MessageCompletedStreamEvent["data"] = { ...eventData, finishReason: "stop", message };
  if (interim) data.interim = true;
  return { type: "message.completed", data };
}

describe("TurnEndTracker", () => {
  it("streams past a held turn's waiting boundary to the turn's end", () => {
    const tracker = new TurnEndTracker();
    const ends = [
      reply("Started the lookup."),
      { type: "turn.completed", data: { held: true, sequence: 1, turnId: "turn_1" } },
      WAITING,
      reply("Q3 revenue is 4.2M."),
      { type: "turn.completed", data: { sequence: 1, turnId: "turn_1" } },
      WAITING,
    ].map((event) => tracker.observe(event as UnstampedMessageStreamEvent));

    expect(ends).toEqual([false, false, false, false, false, true]);
  });

  it("stops at a held boundary where a task's question waits on a person", () => {
    const tracker = new TurnEndTracker();
    const request = {
      action: { callId: "call_1", input: {}, kind: "tool-call" as const, toolName: "deploy" },
      kind: "question" as const,
      prompt: "Which region?",
      requestId: "q-1",
    };
    tracker.observe({ type: "input.requested", data: { ...eventData, requests: [request] } });
    tracker.observe({
      type: "turn.completed",
      data: { held: true, sequence: 1, turnId: "turn_1" },
    });

    expect(tracker.held).toBe(true);
    expect(tracker.observe(WAITING)).toBe(true);
  });

  it("ends a held turn that is cancelled after its boundary", () => {
    const tracker = new TurnEndTracker();
    tracker.observe({
      type: "turn.completed",
      data: { held: true, sequence: 1, turnId: "turn_1" },
    });
    expect(tracker.observe(WAITING)).toBe(false);
    tracker.observe({ type: "turn.cancelled", data: { sequence: 1, turnId: "turn_1" } });
    expect(tracker.observe(WAITING)).toBe(true);
  });
});

describe("held turns", () => {
  it("collect to the turn's end, and the interim message is never the turn's message", async () => {
    async function* stream(): AsyncGenerator<UnstampedMessageStreamEvent> {
      yield reply("Started the lookup.", true);
      yield { type: "turn.completed", data: { held: true, sequence: 1, turnId: "turn_1" } };
      yield WAITING;
      yield reply("Q3 revenue is 4.2M.");
      yield { type: "turn.completed", data: { sequence: 1, turnId: "turn_1" } };
      yield WAITING;
      yield { type: "session.completed" };
    }

    const events = await collectTurnEvents(stream());

    expect(events).toHaveLength(6);
    expect(summarizeTurnEvents(events)).toMatchObject({
      message: "Q3 revenue is 4.2M.",
      status: "waiting",
    });
    expect(summarizeTurnEvents([reply("Started the lookup.", true)]).message).toBeUndefined();
  });
});
