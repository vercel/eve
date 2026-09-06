import { expect, it } from "vitest";
import { sessionInboxMigrations } from "#execution/wire/session-inbox/migrations.js";
import { SESSION_INBOX_WIRE_VERSIONS } from "#execution/wire/session-inbox-contract.js";
import { schemas } from "#execution/wire/session-inbox/generated/schemas.js";

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
