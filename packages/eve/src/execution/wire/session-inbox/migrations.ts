import { sessionInboxWireV0Migration } from "#execution/wire/session-inbox-wire.v0.js";
import type { Wire } from "#execution/wire/session-inbox/migration.js";
import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import {
  SessionInboxWireError,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { migrations as sessionInboxMigrations } from "#execution/wire/session-inbox/generated/catalog.js";
import type { CurrentWire } from "#execution/wire/session-inbox/generated/versions.js";
export { sessionInboxMigrations };

/** The decoder has checked the version; each edge is typed against frozen contracts. */
export const sessionInboxUpMigrations: readonly VersionMigration[] = [
  sessionInboxWireV0Migration,
  ...sessionInboxMigrations.map((migration) => ({
    from: migration.from,
    to: migration.to,
    migrate: (wire: unknown) => migration.up(wire as never),
  })),
];

export function downgradeSessionInbox(
  wire: CurrentWire,
  target: SessionInboxWireVersion,
): Wire<SessionInboxWireVersion> {
  let value: Wire<SessionInboxWireVersion> = wire;
  while (value.version > target) {
    const migration = sessionInboxMigrations.find((entry) => entry.to === value.version);
    if (migration === undefined || migration.to !== migration.from + 1) {
      throw new SessionInboxWireError(
        `No session inbox migration from wire version ${value.version}.`,
      );
    }
    // Version dispatch selects the matching input type from this heterogeneous tuple.
    value = migration.down(value as never);
    if (value.version !== migration.from)
      throw new SessionInboxWireError("Invalid session inbox migration version.");
  }
  return value;
}
