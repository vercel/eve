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

/** Returns whether the current request is authenticated as eve's schedule principal. */
export function isScheduleAppAuth(
  auth: SessionAuthContext | null | undefined,
): auth is SessionAuthContext {
  return (
    auth?.authenticator === SCHEDULE_APP_AUTH.authenticator &&
    auth.principalId === SCHEDULE_APP_AUTH.principalId &&
    auth.principalType === SCHEDULE_APP_AUTH.principalType
  );
}
