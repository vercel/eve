import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV7Schema } from "#execution/wire/session-inbox-wire.v7.js";

const agentRequest = {
  replyTo: "agent-reply",
  request: {
    input: { message: "Find it", target: "research" },
    invocationId: "call-1:research",
    kind: "agent-invoke" as const,
    parentActionCallId: "call-1",
  },
  taskId: "task-1",
};

describe("session inbox wire v7", () => {
  it("round-trips workflow action identity", () => {
    const wire = sessionInboxWire.encode(
      { kind: "send", payload: { task: { agentRequests: [agentRequest] } } },
      { version: 7 },
    );

    expect(sessionInboxWireDecoder.decode(wire)).toMatchObject({
      payloads: [{ task: { agentRequests: [agentRequest] } }],
    });
  });

  it.each([4, 5, 6] as const)("strips workflow action identity for a v%i consumer", (version) => {
    const wire = sessionInboxWire.encode(
      { kind: "send", payload: { task: { agentRequests: [agentRequest] } } },
      { version },
    );

    expect(
      (
        wire as {
          payload: { task: { agentRequests: Array<{ request: object }> } };
        }
      ).payload.task.agentRequests[0]?.request,
    ).not.toHaveProperty("parentActionCallId");
  });

  it.each([4, 5, 6] as const)(
    "rejects v7 identity falsely declared as immutable v%i",
    (version) => {
      expect(() =>
        sessionInboxWireDecoder.decode({
          kind: "deliver",
          payload: { task: { agentRequests: [agentRequest] } },
          payloads: [{ task: { agentRequests: [agentRequest] } }],
          version,
        }),
      ).toThrow(new RegExp(`does not match wire version ${version}`));
    },
  );

  it("pins the complete schema byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxWireV7Schema, { io: "input", unrepresentable: "any" }),
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
