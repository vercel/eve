import { expect, it } from "vitest";
import { sessionInboxMigrations } from "#execution/session-inbox/migrations.js";
import { SESSION_INBOX_WIRE_VERSIONS } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";
import { sessionInboxWireV3Schema } from "#execution/wire/session-inbox-wire.v3.js";
import { sessionInboxWireV4Schema } from "#execution/wire/session-inbox-wire.v4.js";
import { sessionInboxWireV5Schema } from "#execution/wire/session-inbox-wire.v5.js";
import { sessionInboxWireV6Schema } from "#execution/wire/session-inbox-wire.v6.js";

const schemas = {
  1: sessionInboxWireV1Schema,
  2: sessionInboxWireV2Schema,
  3: sessionInboxWireV3Schema,
  4: sessionInboxWireV4Schema,
  5: sessionInboxWireV5Schema,
  6: sessionInboxWireV6Schema,
};

it("has exactly one adjacent migration for every supported version transition", () => {
  expect(sessionInboxMigrations.map((m) => [m.from, m.to])).toEqual(
    SESSION_INBOX_WIRE_VERSIONS.slice(1).map((v) => [v - 1, v]),
  );
});

it.each(sessionInboxMigrations)(
  "validates both directions of $from → $to against frozen schemas",
  (migration) => {
    const original = {
      kind: "deliver",
      payload: { message: "hello" },
      payloads: [{ message: "hello" }],
      version: migration.from,
    };
    const oldWire = schemas[migration.from].parse(original);
    const newWire = migration.up(oldWire as never);
    expect(schemas[migration.to].safeParse(newWire).success).toBe(true);
    const returned = migration.down(newWire as never);
    expect(schemas[migration.from].safeParse(returned).success).toBe(true);
    expect(returned).toEqual(original);
  },
);
