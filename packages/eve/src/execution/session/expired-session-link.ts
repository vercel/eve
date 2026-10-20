import { createHook } from "#compiled/@workflow/core/index.js";

import { disposeHook } from "#execution/hook-ownership.js";
import { supportsExpiredSessionLinksStep } from "#execution/session/expired-session-link-steps.js";

/**
 * How long an address stays linked to the session that timed out there. A
 * link whose session's run data is already gone links nothing.
 */
const EXPIRED_SESSION_LINK_RETENTION = "30d";

/** Token of the retained hook that names the session last timed out at an address. */
export function expiredSessionLinkToken(continuationToken: string): string {
  return `eve:expired:${continuationToken}`;
}

/**
 * Links a session that timed out to its current continuation address, so the
 * next session started there names it as its predecessor. The link is a
 * retained hook: it outlives this run and can be found by token, but it can
 * never be resumed. Worlds without retained hooks leave no link.
 */
export async function linkExpiredSession(input: {
  readonly continuationToken: string;
  readonly sessionId: string;
}): Promise<void> {
  if (!(await supportsExpiredSessionLinksStep())) return;
  const link = createHook<never>({
    // Replaces the link an earlier session at this address left.
    experimental_force: true,
    experimental_minRetention: EXPIRED_SESSION_LINK_RETENTION,
    metadata: { sessionId: input.sessionId },
    token: expiredSessionLinkToken(input.continuationToken),
  });
  await link.getConflict();
}

/**
 * Releases the link a new session continued from. Without this, a session
 * started at the address after this one is reset would still name the older
 * timed-out session.
 */
export async function releaseExpiredSessionLink(continuationToken: string): Promise<void> {
  const link = createHook<never>({
    experimental_force: true,
    token: expiredSessionLinkToken(continuationToken),
  });
  await link.getConflict();
  await disposeHook(link);
}
