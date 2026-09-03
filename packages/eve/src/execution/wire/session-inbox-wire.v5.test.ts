import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV5Schema } from "#execution/wire/session-inbox-wire.v5.js";

const agentRequest = {
  actionCallId: "call-1",
  replyTo: "agent-reply",
  request: {
    input: { message: "Find it", target: "research" },
    instrumentationCallId: "call-1",
    invocationId: "call-1:research",
    kind: "agent-invoke" as const,
  },
  taskId: "task-1",
};

describe("session inbox wire v5", () => {
  it("round-trips an outer action identity for nested workflow agent calls", () => {
    const wire = sessionInboxWire.encode(
      { kind: "send", payload: { task: { agentRequests: [agentRequest] } } },
      { version: 5 },
    );

    expect(sessionInboxWireDecoder.decode(wire)).toMatchObject({
      kind: "deliver",
      payloads: [{ task: { agentRequests: [agentRequest] } }],
    });
  });

  it("strips the action identity for a v4 consumer while keeping its decoder strict", () => {
    const legacyWire = sessionInboxWire.encode(
      { kind: "send", payload: { task: { agentRequests: [agentRequest] } } },
      { version: 4 },
    );
    expect(sessionInboxWireDecoder.decode(legacyWire)).toMatchObject({
      payloads: [
        {
          task: {
            agentRequests: [
              {
                replyTo: agentRequest.replyTo,
                request: {
                  input: agentRequest.request.input,
                  invocationId: agentRequest.request.invocationId,
                  kind: "agent-invoke",
                },
                taskId: agentRequest.taskId,
              },
            ],
          },
        },
      ],
    });
    expect(() =>
      sessionInboxWireDecoder.decode({
        kind: "deliver",
        payload: { task: { agentRequests: [agentRequest] } },
        payloads: [{ task: { agentRequests: [agentRequest] } }],
        version: 4,
      }),
    ).toThrow(/does not match wire version 4/);
  });

  it("migrates a v4 agent request without an outer action identity", () => {
    const { actionCallId: _actionCallId, request, ...delivery } = agentRequest;
    const { instrumentationCallId: _instrumentationCallId, ...legacyRequest } = request;
    const legacy = { ...delivery, request: legacyRequest };

    expect(
      sessionInboxWireDecoder.decode({
        kind: "deliver",
        payload: { task: { agentRequests: [legacy] } },
        payloads: [{ task: { agentRequests: [legacy] } }],
        version: 4,
      }),
    ).toMatchObject({ payloads: [{ task: { agentRequests: [legacy] } }] });
  });

  it("pins the complete schema byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxWireV5Schema, { io: "input", unrepresentable: "any" }),
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
