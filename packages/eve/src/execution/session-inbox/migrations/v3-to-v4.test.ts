import { expect, it } from "vitest";
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
