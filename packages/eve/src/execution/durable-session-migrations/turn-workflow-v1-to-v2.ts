import type { VersionMigration } from "./chain.js";

export const turnWorkflowInputV1ToV2: VersionMigration = {
  from: 1,
  migrate(prior) {
    return { ...(prior as Record<string, unknown>), version: 2 };
  },
  to: 2,
};
