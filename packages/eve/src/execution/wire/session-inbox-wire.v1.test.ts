import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { encodeSessionCommand } from "#execution/wire/session-inbox-encoder.js";
import { SESSION_INBOX_WIRE_VERSION } from "#execution/wire/session-inbox-contract.js";
import { decodeSessionInbox, SessionInboxWireError } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";

const FROZEN_SHAPES = [1] as const;
const FROZEN_FIXTURES = {
  clear: '{"kind":"clear","version":1}',
  deliver:
    '{"auth":null,"kind":"deliver","payload":{"message":"wire"},"payloads":[{"message":"wire"}],"requestId":"req-wire","version":1}',
} as const;

describe("session inbox wire v1", () => {
  it("freezes exactly version 1", () => {
    expect(FROZEN_SHAPES).toEqual([SESSION_INBOX_WIRE_VERSION]);
  });

  it("pins the complete schema byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxWireV1Schema, { io: "input", unrepresentable: "any" }),
      ),
    ).toMatchSnapshot();
  });

  it("encodes a send as the frozen v1 delivery and round-trips", () => {
    const wire = encodeSessionCommand({
      auth: null,
      kind: "send",
      payload: { message: "wire" },
      requestId: "req-wire",
    });
    expect(stableStringify(wire)).toBe(FROZEN_FIXTURES.deliver);
    expect(decodeSessionInbox(JSON.parse(JSON.stringify(wire)))).toEqual({
      auth: null,
      caller: undefined,
      kind: "deliver",
      payloads: [{ message: "wire" }],
      requestId: "req-wire",
    });
  });

  it("preserves the current delivery, task, caller, and turn-control fields", () => {
    const caller = {
      callId: "call-1",
      replyTo: {
        kind: "callback" as const,
        token: "callback-token",
        url: "https://example.com/callback",
      },
      subagentName: "researcher",
      taskId: "task-1",
    };
    const task = {
      views: [
        {
          metadata: {
            agentId: "agent-1",
            kind: "subagent" as const,
            mode: "local" as const,
            name: "researcher",
          },
          status: "working" as const,
          taskId: "task-1",
        },
      ],
    };
    const wire = encodeSessionCommand({
      caller,
      delivery: {
        channelKind: "http",
        channelName: "web",
        deliveryId: "delivery-1",
        requestTraceContext: { spanId: "span-1", traceFlags: 1, traceId: "trace-1" },
      },
      kind: "send",
      payload: { task },
      taskDeliveryId: "task-delivery-1",
      turnPolicy: "queue",
    });

    expect(decodeSessionInbox(JSON.parse(JSON.stringify(wire)))).toEqual({
      auth: undefined,
      caller,
      deliveryMetadata: [
        {
          channelKind: "http",
          channelName: "web",
          deliveryId: "delivery-1",
          payloadIndex: 0,
          requestTraceContext: { spanId: "span-1", traceFlags: 1, traceId: "trace-1" },
        },
      ],
      kind: "deliver",
      payloads: [{ task }],
      requestId: undefined,
      taskDeliveryId: "task-delivery-1",
      turnPolicy: "queue",
    });
    expect(decodeSessionInbox(encodeSessionCommand({ kind: "cancel", taskId: "task-1" }))).toEqual({
      kind: "cancel",
      taskId: "task-1",
      turnId: undefined,
    });
  });

  it("encodes controls with v1 and round-trips", () => {
    const clear = encodeSessionCommand({ kind: "clear" });
    expect(stableStringify(clear)).toBe(FROZEN_FIXTURES.clear);
    expect(decodeSessionInbox(clear)).toEqual({ kind: "clear" });
    expect(decodeSessionInbox(encodeSessionCommand({ kind: "session-timeout" }))).toEqual({
      kind: "session-timeout",
    });
    expect(decodeSessionInbox(encodeSessionCommand({ kind: "cancel", turnId: "turn_9" }))).toEqual({
      kind: "cancel",
      turnId: "turn_9",
    });
  });

  it("keeps the transitional mirror equal to the delivery", () => {
    const wire = encodeSessionCommand({ kind: "send", payload: { message: "m" } });
    expect(wire.kind).toBe("deliver");
    if (wire.kind === "deliver") expect(wire.payloads[0]).toEqual(wire.payload);
  });

  it("does not persist undeclared command fields and preserves adapter extensions", () => {
    const payload = { interaction: { slack: true }, message: "hi" };
    const encoded = encodeSessionCommand({
      kind: "send",
      payload,
      stowaway: "must not persist",
    } as never);
    expect(encoded).not.toHaveProperty("stowaway");
    expect(encoded.kind === "deliver" && encoded.payloads[0]).toEqual(payload);
  });

  it.each([
    ["input response", { inputResponses: [{ requestId: 7 }] }],
    ["context", { context: ["valid", 7] }],
    ["message part", { message: [{ text: 7, type: "text" }] }],
    ["output schema", { outputSchema: { invalid: () => undefined } }],
  ])("rejects a malformed eve-owned %s before persistence", (_name, payload) => {
    expect(() => encodeSessionCommand({ kind: "send", payload } as never)).toThrowError(
      SessionInboxWireError,
    );
  });

  it.each([
    ["a future wire version", { kind: "deliver", payloads: [], version: 2 }],
    ["a non-numeric version", { kind: "deliver", payloads: [], version: "1" }],
    ["an unrecognized kind", { kind: "mystery", version: 1 }],
  ])("rejects %s instead of reinterpreting it", (_name, payload) => {
    expect(() => decodeSessionInbox(payload)).toThrowError(SessionInboxWireError);
  });

  it("reports an unknown newer version as written by a newer deployment", () => {
    expect(() => decodeSessionInbox({ kind: "deliver", payloads: [], version: 99 })).toThrowError(
      /newer/,
    );
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
