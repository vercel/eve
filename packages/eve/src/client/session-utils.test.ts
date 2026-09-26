import { describe, expect, it } from "vitest";

import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

import { collectTurnEvents, summarizeTurnEvents } from "./session-utils.js";

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

  it("reports only unresolved requests after approval settlement or input resolution", () => {
    const request = (requestId: string) => ({
      action: {
        callId: `call_${requestId}`,
        input: {},
        kind: "tool-call" as const,
        toolName: "bash",
      },
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [{ id: "approve", label: "Approve" }],
      prompt: "Approve?",
      requestId,
    });
    const events = [
      {
        type: "input.requested",
        data: {
          ...eventData,
          requests: [request("settled"), request("resolved"), request("open")],
        },
      },
      {
        type: "approval.settled",
        data: {
          ...eventData,
          outcome: "approved",
          requestId: "settled",
          responderPrincipalId: "alice",
        },
      },
      {
        type: "input.resolved",
        data: {
          ...eventData,
          resolutions: [{ kind: "tool-approval", outcome: "denied", requestId: "resolved" }],
        },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ] satisfies UnstampedMessageStreamEvent[];
    expect(summarizeTurnEvents(events).inputRequests).toEqual([request("open")]);
  });

  it("keeps an independent same-name attempt pending until its own completion", () => {
    const required = (attemptId: string) => ({
      type: "authorization.required" as const,
      data: { ...eventData, attemptId, description: "Sign in", name: "linear" },
    });
    const events = [
      required("alice"),
      required("bob"),
      {
        type: "authorization.completed",
        data: { ...eventData, attemptId: "alice", name: "linear", outcome: "authorized" },
      },
    ] satisfies UnstampedMessageStreamEvent[];
    expect(summarizeTurnEvents(events).pendingAuthorizations).toEqual([required("bob").data]);
  });

  it("does not clear a legacy name-only attempt with an unrelated identified completion", () => {
    const events = [
      {
        type: "authorization.required",
        data: { ...eventData, description: "Sign in", name: "linear" },
      },
      {
        type: "authorization.completed",
        data: { ...eventData, attemptId: "alice", name: "linear", outcome: "authorized" },
      },
    ] satisfies UnstampedMessageStreamEvent[];
    expect(summarizeTurnEvents(events).pendingAuthorizations).toEqual([events[0]!.data]);
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
