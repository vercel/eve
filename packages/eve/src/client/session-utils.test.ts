import type { SessionEvent } from "#protocol/session-event.js";
import { describe, expect, it } from "vitest";

import { collectTurnEvents, summarizeTurnEvents, TurnSegment } from "./session-utils.js";

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
    ] satisfies SessionEvent[];

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
    ] satisfies SessionEvent[];
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
    ] satisfies SessionEvent[];
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
    ] satisfies SessionEvent[];
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
    ] satisfies SessionEvent[];

    expect(summarizeTurnEvents(events)).toMatchObject({
      failure: { type: "turn.failed", data: { message: "Unavailable" } },
      pendingAuthorizations: [],
      status: "waiting",
    });
  });
});

describe("collectTurnEvents", () => {
  it("stops at the current-turn boundary", async () => {
    async function* stream(): AsyncGenerator<SessionEvent> {
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

describe("TurnSegment", () => {
  const signIn: SessionEvent = {
    type: "authorization.required",
    data: { ...eventData, description: "Sign in", name: "linear", webhookUrl: "https://auth" },
  };
  const held: SessionEvent = {
    type: "turn.waiting",
    data: { on: "input", sequence: 1, turnId: "turn_1" },
  };

  it("reads past a held sign-in only while following its callback", () => {
    const resumed: SessionEvent[] = [
      {
        type: "authorization.completed",
        data: { ...eventData, name: "linear", outcome: "authorized" },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ];
    const following = new TurnSegment({ followCallbacks: true });
    expect([signIn, held, ...resumed].map((event) => following.observe(event))).toEqual([
      false,
      false,
      false,
      true,
    ]);

    const plain = new TurnSegment();
    expect([signIn, held].map((event) => plain.observe(event))).toEqual([false, true]);
  });

  it("stops at a held sign-in when an approval also waits on the person", () => {
    const segment = new TurnSegment({ followCallbacks: true });
    const approval: SessionEvent = {
      type: "input.requested",
      data: {
        ...eventData,
        requests: [
          {
            action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "deploy" },
            kind: "tool-approval",
            prompt: "Approve deploy?",
            requestId: "req_1",
          },
        ],
      },
    };
    expect([approval, signIn, held].map((event) => segment.observe(event))).toEqual([
      false,
      false,
      true,
    ]);
  });
});
