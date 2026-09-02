import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";

/** Pure shape migration from the immutable v1 wire contract to v2. */
export const sessionInboxWireV1Migration: VersionMigration = {
  from: 1,
  migrate(prior) {
    const value = prior as Record<string, unknown>;
    const migrated: Record<string, unknown> & { readonly version: 2 } = {
      ...value,
      version: 2,
    };
    if (value.kind === "deliver" && !("payload" in value)) migrated.payload = {};
    return migrated;
  },
  to: 2,
};
