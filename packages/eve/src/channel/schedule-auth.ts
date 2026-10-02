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

/**
 * Returns true when `auth` is the default app principal that schedules pass
 * as `appAuth`. It identifies that principal, not how a turn started: a
 * schedule handler may send with a user's auth instead, and any code can
 * reuse `appAuth`.
 *
 * @example
 * ```ts
 * import { isScheduleAuth } from "eve/schedules";
 *
 * if (isScheduleAuth(ctx.session.auth.current)) {
 *   // Work the agent does on its own behalf.
 * }
 * ```
 */
export function isScheduleAuth(auth: SessionAuthContext | null | undefined): boolean {
  return (
    auth?.authenticator === SCHEDULE_APP_AUTH.authenticator &&
    auth.principalId === SCHEDULE_APP_AUTH.principalId &&
    auth.principalType === SCHEDULE_APP_AUTH.principalType
  );
}
