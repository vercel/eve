import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";

/** Pure shape migration from the immutable v2 wire contract to v3. */
export const sessionInboxWireV2Migration: VersionMigration = {
  from: 2,
  migrate(prior) {
    return { ...(prior as Record<string, unknown>), version: 3 };
  },
  to: 3,
};
