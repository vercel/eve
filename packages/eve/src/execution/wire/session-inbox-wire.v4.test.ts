import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV4Schema } from "#execution/wire/session-inbox-wire.v4.js";

const effect = {
  input: {
    callId: "call-1",
    childSessionId: "child-1",
    event: {
      data: {
        description: "Authorize Linear",
        name: "linear",
        sequence: 1,
        stepIndex: 2,
        turnId: "turn-child",
      },
      type: "authorization.required" as const,
    },
    kind: "subagent-authorization-event" as const,
    subagentName: "research",
  },
  invocationId: "call-1:research:event:0",
  name: "agent.event",
  replyTo: "agent-reply",
  taskId: "task-1",
};
const inputRequest = {
  replyTo: "answer-hook",
  request: { kind: "question", prompt: "Continue?", requestId: "request-1" },
  sequence: 2,
  stepIndex: 3,
  taskId: "task-1",
  turnId: "turn-1",
};

describe("session inbox wire v4", () => {
  it("round-trips task-owned workflow effects and input requests", () => {
    const wire = sessionInboxWire.encode(
      {
        kind: "send",
        payload: { task: { effects: [effect], inputRequests: [inputRequest] } },
      },
      { version: 4 },
    );

    expect(sessionInboxWireDecoder.decode(wire)).toMatchObject({
      kind: "deliver",
      payloads: [{ task: { effects: [effect], inputRequests: [inputRequest] } }],
    });
  });

  it.each([1, 2, 3] as const)("keeps v%i strict for task workflow effects", (version) => {
    expect(() =>
      sessionInboxWire.encode(
        { kind: "send", payload: { task: { effects: [effect] } } },
        { version },
      ),
    ).toThrow(new RegExp(`wire version ${version}`));
  });

  it.each([1, 2, 3] as const)(
    "rejects v4 task effects falsely declared as immutable v%i",
    (version) => {
      expect(() =>
        sessionInboxWireDecoder.decode({
          kind: "deliver",
          payload: { task: { effects: [effect] } },
          payloads: [{ task: { effects: [effect] } }],
          version,
        }),
      ).toThrow(new RegExp(`does not match wire version ${version}`));
    },
  );

  it("round-trips batched task input requests", () => {
    const { request: _request, ...batch } = inputRequest;
    const batchedRequest = { ...batch, requests: [inputRequest.request] };

    expect(
      sessionInboxWireDecoder.decode({
        kind: "deliver",
        payload: { task: { inputRequests: [batchedRequest] } },
        payloads: [{ task: { inputRequests: [batchedRequest] } }],
        version: 4,
      }),
    ).toMatchObject({
      payloads: [{ task: { inputRequests: [batchedRequest] } }],
    });
  });

  it("carries current task messages through the stable raw-send fast path", () => {
    const wire = sessionInboxWire.encode(
      {
        kind: "send",
        payload: { task: { effects: [effect], inputRequests: [inputRequest] } },
      },
      { variant: "send", version: 0 },
    );

    expect(wire).toMatchObject({
      kind: "send",
      payload: { task: { effects: [effect], inputRequests: [inputRequest] } },
    });
    expect(sessionInboxWireDecoder.decode(wire)).toMatchObject({
      kind: "deliver",
      payloads: [{ task: { effects: [effect], inputRequests: [inputRequest] } }],
    });
  });

  it("round-trips accepted deployment provenance", () => {
    const delivery = {
      acceptedDeploymentId: "dpl_current",
      channelKind: "channel:webhook",
      channelName: "webhook",
      deliveryId: "delivery-1",
    };
    const wire = sessionInboxWire.encode(
      { delivery, kind: "send", payload: { message: "hello" } },
      { version: 4 },
    );

    expect(sessionInboxWireDecoder.decode(wire)).toMatchObject({
      deliveryMetadata: [{ ...delivery, payloadIndex: 0 }],
      kind: "deliver",
    });
  });

  it("pins the complete schema byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxWireV4Schema, { io: "input", unrepresentable: "any" }),
      ),
    ).toMatchSnapshot();
  });
});

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}
