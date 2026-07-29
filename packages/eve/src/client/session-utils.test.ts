import { describe, expect, it } from "vitest";

import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

import { collectTurnEvents, summarizeTurnEvents } from "./session-utils.js";

const eventData = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

describe("summarizeTurnEvents", () => {
  it("projects the complete waiting-turn lifecycle in one pass", () => {
    const request = {
      action: { callId: "call_1", input: {}, kind: "tool-call" as const, toolName: "bash" },
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
        data: { continuationToken: "eve:next", wait: "next-user-message" },
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
        data: { continuationToken: "eve:next", wait: "next-user-message" },
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
        data: { continuationToken: "eve:next", wait: "next-user-message" },
      };
      yield { type: "session.completed" };
    }

    await expect(collectTurnEvents(stream())).resolves.toEqual([
      {
        type: "session.waiting",
        data: { continuationToken: "eve:next", wait: "next-user-message" },
      },
    ]);
  });
});
