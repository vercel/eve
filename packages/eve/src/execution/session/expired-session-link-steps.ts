import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { expiredSessionLinkToken } from "#execution/session/expired-session-link.js";
import { DevelopmentRunUnavailableError } from "#internal/workflow/development-run-unavailable-error.js";
import { createLogger, logError } from "#internal/logging.js";
import { getHookByToken, getWorld } from "#internal/workflow/runtime.js";
import type { SessionPredecessor } from "#protocol/message.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("execution.expired-session-link");

/** Whether the World keeps a hook findable after its run ends and lets a later run replace it. */
export async function supportsExpiredSessionLinksStep(): Promise<boolean> {
  "use step";
  const { capabilities } = await getWorld();
  return capabilities?.hookForceClaim === true && capabilities.hookRetention?.active === true;
}

/** The session that last timed out at a continuation address, while its link remains readable. */
export async function findExpiredSession(
  continuationToken: string,
): Promise<SessionPredecessor | undefined> {
  let link;
  try {
    link = await getHookByToken(expiredSessionLinkToken(continuationToken));
  } catch (error) {
    // The `eve dev` World hides hooks of runs from a generation it will not execute.
    if (HookNotFoundError.is(error) || DevelopmentRunUnavailableError.is(error)) return undefined;
    throw error;
  }
  let metadata: unknown;
  try {
    metadata = await link.metadata;
  } catch (error) {
    // Metadata is run data, so it is unreadable once the expired run's retention ends.
    logError(log, "expired session link is unreadable", error, { continuationToken });
    return undefined;
  }
  return isObject(metadata) && typeof metadata.sessionId === "string"
    ? { sessionId: metadata.sessionId }
    : undefined;
}
