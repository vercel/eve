import { describe, expect, it } from "vitest";

import { z } from "#compiled/zod/index.js";
import {
  decodeSessionInbox,
  encodeSessionCommand,
  SESSION_INBOX_WIRE_VERSION,
  SessionInboxWireError,
  sessionInboxWireSchema,
} from "#execution/wire/session-inbox-wire.js";

/**
 * Frozen wire contract for the `session-inbox` family.
 *
 * FROZEN_SHAPES pins the current version's structural schema (as JSON
 * Schema): editing the shipped shape cannot pass this test — bump
 * SESSION_INBOX_WIRE_VERSION, add a migration, and freeze the new shape
 * instead. FROZEN_FIXTURES pins backwards compatibility: every payload ever
 * persisted by a shipped version must keep decoding on the current build.
 */
const FROZEN_SHAPES: Readonly<Record<number, string>> = {
  1: `{"$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"additionalProperties":false,"properties":{"auth":{"anyOf":[{},{"type":"null"}]},"caller":{},"kind":{"const":"deliver","type":"string"},"payload":{},"payloads":{"items":{},"type":"array"},"requestId":{"type":"string"},"version":{"const":1,"type":"number"}},"required":["kind","payloads","version"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"session-timeout","type":"string"},"version":{"const":1,"type":"number"}},"required":["kind","version"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"clear","type":"string"},"version":{"const":1,"type":"number"}},"required":["kind","version"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"compact","type":"string"},"version":{"const":1,"type":"number"}},"required":["kind","version"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"reset","type":"string"},"reason":{"type":"string"},"version":{"const":1,"type":"number"}},"required":["kind","version"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"cancel","type":"string"},"turnId":{"type":"string"},"version":{"const":1,"type":"number"}},"required":["kind","version"],"type":"object"}]}`,
};

const FROZEN_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly version: number;
  readonly payload: string;
  readonly decoded: unknown;
}> = [
  {
    name: "legacy deliver envelope (≤0.30.2 producers)",
    version: 0,
    payload: '{"kind":"deliver","payloads":[{"message":"legacy"}]}',
    decoded: { kind: "deliver", payloads: [{ message: "legacy" }] },
  },
  {
    name: "raw send command (0.30.3–0.30.8 producers)",
    version: 0,
    payload: '{"auth":null,"kind":"send","payload":{"message":"mid"},"requestId":"req-0"}',
    decoded: { auth: null, kind: "deliver", payloads: [{ message: "mid" }], requestId: "req-0" },
  },
  {
    name: "unversioned cancel control",
    version: 0,
    payload: '{"kind":"cancel","turnId":"turn_1"}',
    decoded: { kind: "cancel", turnId: "turn_1" },
  },
  {
    name: "unversioned session-timeout control",
    version: 0,
    payload: '{"kind":"session-timeout"}',
    decoded: { kind: "session-timeout" },
  },
  {
    name: "v1 deliver envelope with the single-payload mirror",
    version: 1,
    payload:
      '{"auth":null,"kind":"deliver","payload":{"message":"wire"},"payloads":[{"message":"wire"}],"requestId":"req-wire","version":1}',
    decoded: {
      auth: null,
      kind: "deliver",
      payloads: [{ message: "wire" }],
      requestId: "req-wire",
    },
  },
  {
    name: "v1 clear control",
    version: 1,
    payload: '{"kind":"clear","version":1}',
    decoded: { kind: "clear" },
  },
];

describe("session inbox wire contract", () => {
  it("freezes exactly the current version's shape", () => {
    expect(Object.keys(FROZEN_SHAPES)).toEqual([String(SESSION_INBOX_WIRE_VERSION)]);
  });

  it("the current schema matches its frozen shape byte for byte", () => {
    const shape = stableStringify(
      z.toJSONSchema(sessionInboxWireSchema, { unrepresentable: "any" }),
    );
    expect(shape).toBe(FROZEN_SHAPES[SESSION_INBOX_WIRE_VERSION]);
  });

  it.each(FROZEN_FIXTURES)(
    "keeps decoding the frozen $name fixture (backwards compatibility)",
    ({ payload, decoded }) => {
      expect(decodeSessionInbox(JSON.parse(payload))).toEqual(decoded);
    },
  );

  it("encoded sends are byte-frozen and round-trip through decode", () => {
    const wire = encodeSessionCommand({
      auth: null,
      kind: "send",
      payload: { message: "wire" },
      requestId: "req-wire",
    });

    expect(stableStringify(wire)).toBe(
      FROZEN_FIXTURES.find((f) => f.name.startsWith("v1 deliver"))!.payload,
    );
    expect(decodeSessionInbox(JSON.parse(JSON.stringify(wire)))).toEqual({
      auth: null,
      caller: undefined,
      kind: "deliver",
      payloads: [{ message: "wire" }],
      requestId: "req-wire",
    });
  });

  it("encoded controls are versioned and round-trip through decode", () => {
    const wire = encodeSessionCommand({ kind: "clear" });
    expect(stableStringify(wire)).toBe(
      FROZEN_FIXTURES.find((f) => f.name === "v1 clear control")!.payload,
    );
    expect(decodeSessionInbox(JSON.parse(JSON.stringify(wire)))).toEqual({ kind: "clear" });

    expect(decodeSessionInbox(encodeSessionCommand({ kind: "session-timeout" }))).toEqual({
      kind: "session-timeout",
    });
    expect(decodeSessionInbox(encodeSessionCommand({ kind: "cancel", turnId: "turn_9" }))).toEqual({
      kind: "cancel",
      turnId: "turn_9",
    });
  });

  it("the mirror and the payloads entry reference the same delivery", () => {
    const wire = encodeSessionCommand({ auth: null, kind: "send", payload: { message: "m" } });
    expect(wire.kind).toBe("deliver");
    // Opaque interiors cross by reference, so the alias survives encoding and
    // devalue can persist the delivery once instead of twice.
    if (wire.kind === "deliver") expect(wire.payloads[0]).toBe(wire.payload);
  });

  it("strips envelope fields the schema does not declare, keeping interiors opaque", () => {
    const payload = { interaction: { slack: true }, message: "hi" };
    const encoded = encodeSessionCommand({
      auth: null,
      kind: "send",
      payload,
      stowaway: "must not persist",
    } as never);

    expect(encoded).not.toHaveProperty("stowaway");
    // Adapter-owned interiors are asserted only to be objects, never rewritten.
    expect(encoded.kind === "deliver" && encoded.payloads[0]).toEqual(payload);
  });

  it.each([
    ["a future wire version", { kind: "deliver", payloads: [], version: 2 }],
    ["a non-numeric version", { kind: "deliver", payloads: [], version: "1" }],
    ["an unrecognized kind", { kind: "mystery" }],
    ["a malformed v1 envelope", { kind: "deliver", payloads: "nope", version: 1 }],
    ["a malformed legacy send", { kind: "send", payload: "nope" }],
    ["a non-object payload", "deliver"],
  ])("throws SessionInboxWireError for %s instead of reinterpreting", (_name, payload) => {
    expect(() => decodeSessionInbox(payload)).toThrowError(SessionInboxWireError);
  });

  it("reports an unknown newer version as written by a newer deployment", () => {
    try {
      decodeSessionInbox({ kind: "deliver", payloads: [], version: 99 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SessionInboxWireError);
      expect((error as Error).message).toContain("newer");
    }
  });
});

/** JSON with recursively sorted keys so frozen strings are insertion-order-proof. */
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
