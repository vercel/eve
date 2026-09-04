import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { isObject } from "#shared/guards.js";

/** Advances version-6 payloads to the model-history restoration schema. */
export const sessionInboxWireV6Migration: VersionMigration = {
  from: 6,
  migrate(prior) {
    if (!isObject(prior)) throw new Error("session inbox wire v6 value is not an object.");
    return { ...prior, version: 7 };
  },
  to: 7,
};
