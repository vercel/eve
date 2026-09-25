import { describe, expect, it } from "vitest";

import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

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

describe("TurnEndTracker", () => {
  const turn = { sequence: 1, turnId: "turn_1" };
  const waiting: UnstampedMessageStreamEvent = {
    type: "session.waiting",
    data: { continuationToken: "session-id", wait: "next-user-message" },
  };
  const answer = (message: string): UnstampedMessageStreamEvent => ({
    type: "message.completed",
    data: { ...turn, finishReason: "stop", message, stepIndex: 0 },
  });
  const request = {
    action: { callId: "call_1", input: {}, kind: "tool-call" as const, toolName: "deploy" },
    display: "confirmation" as const,
    kind: "tool-approval" as const,
    options: [{ id: "approve", label: "Approve" }],
    prompt: "Deploy?",
    requestId: "request_1",
  };
  const ends = (events: readonly UnstampedMessageStreamEvent[]) => {
    const tracker = new TurnEndTracker();
    return events.map((event) => tracker.observe(event));
  };

  it("follows a held turn past its session.waiting to its end", () => {
    expect(
      ends([
        { type: "turn.started", data: turn },
        answer("I started a lookup."),
        waiting,
        answer("Q3 was $4.2M."),
        { type: "turn.completed", data: turn },
        waiting,
      ]),
    ).toEqual([false, false, false, false, false, true]);
  });

  it("follows a message that joined a held turn to that turn's end", () => {
    expect(
      ends([
        { type: "message.received", data: { ...turn, message: "Any update?" } },
        answer("Still working on it."),
        waiting,
        answer("Q3 was $4.2M."),
        { type: "turn.completed", data: turn },
        waiting,
      ]),
    ).toEqual([false, false, false, false, false, true]);
  });

  it("ends at an approval park, which ends its turn", () => {
    expect(
      ends([
        { type: "turn.started", data: turn },
        { type: "input.requested", data: { ...turn, requests: [request], stepIndex: 0 } },
        { type: "turn.completed", data: turn },
        waiting,
      ]),
    ).toEqual([false, false, false, true]);
  });

  it("stops at an open turn's session.waiting while a request awaits an answer", () => {
    expect(
      ends([
        { type: "turn.started", data: turn },
        { type: "input.requested", data: { ...turn, requests: [request], stepIndex: 0 } },
        waiting,
      ]),
    ).toEqual([false, false, true]);
  });

  it("ends at session.failed and a turn that failed", () => {
    expect(
      ends([
        { type: "turn.started", data: turn },
        { type: "turn.failed", data: { ...turn, code: "MODEL_ERROR", message: "Failed." } },
        waiting,
      ]),
    ).toEqual([false, false, true]);
    expect(
      ends([
        { type: "turn.started", data: turn },
        {
          type: "session.failed",
          data: { code: "MODEL_ERROR", message: "Failed.", sessionId: "session-id" },
        },
      ]),
    ).toEqual([false, true]);
  });
});
