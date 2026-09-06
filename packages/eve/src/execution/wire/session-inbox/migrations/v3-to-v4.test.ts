import { describe, expect, it } from "vitest";
import { v3ToV4 } from "./v3-to-v4.js";
import { sessionInboxWireV3Schema } from "#execution/wire/session-inbox-wire.v3.js";
import { sessionInboxWireV4Schema } from "#execution/wire/session-inbox-wire.v4.js";

it("turns an old input request into the current answer route without losing its question", () => {
  const request = {
    kind: "tool-approval",
    requestId: "question-1",
    prompt: "Run it?",
    action: { kind: "tool-call", callId: "call-1", toolName: "research", input: {} },
  };
  const payload = {
    task: {
      inputRequests: [
        {
          taskId: "task-1",
          hookPayload: {
            kind: "subagent-input-request",
            callId: "call-1",
            childSessionId: "child-1",
            subagentName: "research",
            childContinuationToken: "answer-hook",
            event: { requests: [request], sequence: 0, stepIndex: 0, turnId: "turn-1" },
          },
        },
      ],
    },
  };
  const old = sessionInboxWireV3Schema.parse({
    kind: "deliver",
    version: 3,
    payload,
    payloads: [payload],
  });
  const upgraded = v3ToV4.up(old);
  expect(sessionInboxWireV4Schema.safeParse(upgraded).success).toBe(true);
  expect(upgraded).toMatchObject({
    payloads: [
      { task: { inputRequests: [{ taskId: "task-1", replyTo: "answer-hook", request }] } },
    ],
  });
});

it("rejects input requests whose old executor route cannot be reconstructed", () => {
  const payload = {
    task: {
      inputRequests: [
        {
          taskId: "task-1",
          replyTo: "answer-hook",
          request: { prompt: "Run it?" },
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        },
      ],
    },
  };
  expect(() => v3ToV4.down({ kind: "deliver", version: 4, payload, payloads: [payload] })).toThrow(
    "wire version 3",
  );
});

describe("session inbox wire v4 migration", () => {
  it("rejects malformed direct migration input", () => {
    expect(() => v3ToV4.up(null as never)).toThrow("session inbox wire v3 value is not an object");
  });

  it("translates legacy task envelopes and preserves v3 provenance", () => {
    const request = {
      kind: "tool-approval" as const,
      prompt: "Continue?",
      requestId: "request-1",
      action: { kind: "tool-call" as const, callId: "call-1", toolName: "research", input: {} },
    };
    const authorization = {
      callId: "call-1",
      childSessionId: "child-1",
      event: { type: "authorization.required" },
      kind: "subagent-authorization-event" as const,
      subagentName: "research",
    };
    const oldExecutor = {
      binding: { data: {}, kind: "subagent" },
      childSessionId: "child-1",
      lifecycle: "parked",
    };
    expect(
      v3ToV4.up({
        deliveryMetadata: [
          {
            acceptedDeploymentId: "dpl_current",
            channelKind: "channel:webhook",
            channelName: "webhook",
            deliveryId: "delivery-1",
            payloadIndex: 0,
          },
        ],
        kind: "deliver",
        payload: {},
        payloads: [
          {
            task: {
              authorizationEvents: [{ hookPayload: authorization, taskId: "task-1" }],
              inputRequests: [
                {
                  hookPayload: {
                    kind: "subagent-input-request",
                    callId: "call-1",
                    childSessionId: "child-1",
                    subagentName: "research",
                    childContinuationToken: "answer-hook",
                    event: { requests: [request], sequence: 2, stepIndex: 3, turnId: "turn-1" },
                  },
                  taskId: "task-1",
                },
              ],
              views: [
                {
                  executor: oldExecutor,
                  metadata: { kind: "subagent", name: "research" },
                  status: "working",
                  taskId: "task-1",
                },
              ],
            },
          },
        ],
        version: 3,
      }),
    ).toMatchObject({
      deliveryMetadata: [{ acceptedDeploymentId: "dpl_current" }],
      kind: "deliver",
      payloads: [
        {
          task: {
            authorizationEvents: [{ hookPayload: authorization, taskId: "task-1" }],
            inputRequests: [
              {
                replyTo: "answer-hook",
                request,
                sequence: 2,
                stepIndex: 3,
                taskId: "task-1",
                turnId: "turn-1",
              },
            ],
            views: [
              {
                executor: { binding: { data: {}, kind: "subagent" } },
                taskId: "task-1",
              },
            ],
          },
        },
      ],
      version: 4,
    });
  });
});
