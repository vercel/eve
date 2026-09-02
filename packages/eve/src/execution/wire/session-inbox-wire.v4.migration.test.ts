import { describe, expect, it } from "vitest";

import { sessionInboxWireV3Migration } from "#execution/wire/session-inbox-wire.v4.migration.js";

describe("session inbox wire v4 migration", () => {
  it("rejects malformed direct migration input", () => {
    expect(() => sessionInboxWireV3Migration.migrate(null)).toThrow(
      "session inbox wire v3 value is not an object",
    );
  });

  it("translates legacy task envelopes and preserves v3 provenance", () => {
    const request = { kind: "question", prompt: "Continue?", requestId: "request-1" };
    const authorization = {
      callId: "call-1",
      childSessionId: "child-1",
      event: { type: "authorization.required" },
      kind: "subagent-authorization-event",
      subagentName: "research",
    };
    expect(
      sessionInboxWireV3Migration.migrate({
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
                    childContinuationToken: "answer-hook",
                    event: { requests: [request], sequence: 2, stepIndex: 3, turnId: "turn-1" },
                  },
                  taskId: "task-1",
                },
              ],
              views: [
                {
                  executor: {
                    binding: { data: {}, kind: "subagent" },
                    childSessionId: "child-1",
                    lifecycle: "parked",
                  },
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
