import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import {
  encodeSessionCommand,
  sessionInboxV1Schema,
} from "#execution/wire/session-inbox-encoder.js";
import { SESSION_INBOX_WIRE_VERSION } from "#execution/wire/session-inbox-contract.js";
import { decodeSessionInbox, SessionInboxWireError } from "#execution/wire/session-inbox-wire.js";

/**
 * Frozen wire contract for the `session-inbox` family.
 *
 * FROZEN_SHAPES pins the current version's structural schema (as JSON
 * Schema): editing the shipped shape cannot pass this test — bump
 * SESSION_INBOX_WIRE_VERSION, add a migration, and freeze the new shape
 * instead. FROZEN_FIXTURES pins backwards compatibility: every payload ever
 * persisted by a shipped version must keep decoding on the current build.
 */
const FROZEN_SHAPES = [1] as const;

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
    expect(FROZEN_SHAPES).toEqual([SESSION_INBOX_WIRE_VERSION]);
  });

  it("the complete current schema matches its frozen shape byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxV1Schema, { io: "input", unrepresentable: "any" }),
      ),
    ).toMatchSnapshot();
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

  it("the mirror and the payloads entry carry the same validated delivery", () => {
    const wire = encodeSessionCommand({ auth: null, kind: "send", payload: { message: "m" } });
    expect(wire.kind).toBe("deliver");
    if (wire.kind === "deliver") expect(wire.payloads[0]).toEqual(wire.payload);
  });

  it("does not persist undeclared command fields and preserves adapter extensions", () => {
    const payload = { interaction: { slack: true }, message: "hi" };
    const encoded = encodeSessionCommand({
      auth: null,
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
    ["a malformed legacy deliver", { kind: "deliver", payloads: "nope" }],
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
