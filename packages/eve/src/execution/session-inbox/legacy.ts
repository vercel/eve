import { runMigrationChain } from "#execution/durable-session-migrations/chain.js";
import type { Wire } from "#execution/session-inbox/migration.js";
import { sessionInboxWireV0Migration } from "#execution/wire/session-inbox-wire.v0.js";
import { sessionInboxWireV1Migration } from "#execution/wire/session-inbox-wire.v2.migration.js";
import { sessionInboxWireV2Migration } from "#execution/wire/session-inbox-wire.v3.migration.js";
import { sessionInboxWireV3Migration } from "#execution/wire/session-inbox-wire.v4.migration.js";

/** Already-persisted raw sends include task fields written before capability checks existed. */
export function upgradeLegacySessionInbox(value: unknown): Wire<4> {
  return runMigrationChain({
    value,
    initialVersion: 0,
    targetVersion: 4,
    label: "session inbox payload",
    migrations: [
      sessionInboxWireV0Migration,
      sessionInboxWireV1Migration,
      sessionInboxWireV2Migration,
      sessionInboxWireV3Migration,
    ],
  });
}
