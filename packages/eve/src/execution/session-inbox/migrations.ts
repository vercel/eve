import type { Wire } from "#execution/session-inbox/migration.js";
import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import {
  SessionInboxWireError,
  type SessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { v1ToV2 } from "#execution/session-inbox/migrations/v1-to-v2.js";
import { v2ToV3 } from "#execution/session-inbox/migrations/v2-to-v3.js";
import { v3ToV4 } from "#execution/session-inbox/migrations/v3-to-v4.js";
import { v4ToV5 } from "#execution/session-inbox/migrations/v4-to-v5.js";
import { v5ToV6 } from "#execution/session-inbox/migrations/v5-to-v6.js";

export const sessionInboxMigrations = [v1ToV2, v2ToV3, v3ToV4, v4ToV5, v5ToV6] as const;

/** The decoder has checked the version; each edge is typed against frozen contracts. */
export const sessionInboxUpMigrations: readonly VersionMigration[] = sessionInboxMigrations.map(
  (migration) => ({
    from: migration.from,
    to: migration.to,
    migrate: (wire) => migration.up(wire as never),
  }),
);

export function downgradeSessionInbox(
  wire: Wire<6>,
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
