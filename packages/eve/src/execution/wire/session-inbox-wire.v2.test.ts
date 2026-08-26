import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { sessionInboxWire as sessionInboxWireEncoder } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";

describe("session inbox wire v2", () => {
  it("pins the complete schema byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxWireV2Schema, { io: "input", unrepresentable: "any" }),
      ),
    ).toMatchSnapshot();
  });

  it("round-trips a resolved direct-agent target", () => {
    const encoded = sessionInboxWireEncoder.encode(
      {
        agentNodeId: "node:researcher",
        kind: "send",
        payload: { message: "investigate" },
      },
      { version: 2 },
    );

    expect(sessionInboxWireV2Schema.safeParse(encoded).success).toBe(true);
    expect(sessionInboxWireDecoder.decode(encoded)).toMatchObject({
      agentNodeId: "node:researcher",
      kind: "deliver",
      payloads: [{ message: "investigate" }],
    });
  });

  it("migrates version-1 deliveries as having no override", () => {
    expect(
      sessionInboxWireDecoder.decode({
        kind: "deliver",
        payloads: [{ message: "legacy" }],
        version: 1,
      }),
    ).toMatchObject({
      kind: "deliver",
      payloads: [{ message: "legacy" }],
    });
    expect(
      sessionInboxWireDecoder.decode({
        kind: "deliver",
        payloads: [{ message: "legacy" }],
        version: 1,
      }),
    ).not.toHaveProperty("agentNodeId", expect.any(String));
  });

  it("rejects targeted sends to consumers that predate direct routing", () => {
    expect(() =>
      sessionInboxWireEncoder.encode(
        {
          agentNodeId: "node:researcher",
          kind: "send",
          payload: { message: "investigate" },
        },
        { version: 1 },
      ),
    ).toThrow(/target session consumes session inbox wire version 1/);
  });
});

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]));
}
