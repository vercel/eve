import type { SessionAuthContext } from "#channel/types.js";

/**
 * Framework-owned principal used when a schedule runs on behalf of the agent.
 */
export const SCHEDULE_APP_AUTH: SessionAuthContext = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
};
