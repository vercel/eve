import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { isObject } from "#shared/guards.js";

/** Advances version-4 payloads to the additive token-cost schema. */
export const sessionInboxWireV4Migration: VersionMigration = {
  from: 4,
  migrate(prior) {
    if (!isObject(prior)) throw new Error("session inbox wire v4 value is not an object.");
    return { ...prior, version: 5 };
  },
  to: 5,
};
