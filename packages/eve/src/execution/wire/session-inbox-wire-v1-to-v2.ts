import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox-wire.v1.js";

/** Version 2 adds an optional resolved direct-agent node to deliver envelopes. */
export const sessionInboxWireV1ToV2: VersionMigration = {
  from: 1,
  to: 2,
  migrate(prior) {
    const parsed = sessionInboxWireV1Schema.parse(prior);
    return { ...parsed, version: 2 };
  },
};
