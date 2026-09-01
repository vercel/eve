import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { normalizeSessionInboxWireV2 } from "#execution/wire/session-inbox-wire.v2-migration.js";

export const sessionInboxWireV2Migration: VersionMigration = {
  from: 2,
  migrate(prior) {
    return {
      ...(normalizeSessionInboxWireV2(prior) as Record<string, unknown>),
      version: 3,
    };
  },
  to: 3,
};

/** Converts Workflow-VM records into this realm before wire consumption. */
export const normalizeSessionInboxWireV3 = normalizeSessionInboxWireV2;
