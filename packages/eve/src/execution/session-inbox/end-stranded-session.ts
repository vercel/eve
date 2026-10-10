import { EVE_SESSION_ATTRIBUTE, EVE_TYPE_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import {
  logicalSessionInboxToken,
  sessionCommandHookToken,
  sessionInboxHookToken,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import { waitForSessionHooksRelease } from "#execution/session-inbox/hook-release.js";
import {
  findSessionHookHolder,
  type StrandedSessionOwnerError,
} from "#execution/session-inbox/owner.js";
import { logicalSessionToken, requireSessionId } from "#execution/session-inbox/resume.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import { isInactiveWorkflowRunError } from "#internal/workflow/is-inactive-workflow-run-error.js";
import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { encodeLine } from "#protocol/session-events/envelope.js";

type World = Awaited<ReturnType<typeof getWorld>>;

const HOOK_PAGE_LIMIT = 100;
/** A session owns a handful of addresses; the cap only bounds a misbehaving World. */
const MAX_HOOK_PAGES = 10;
/** Publication is best effort; a stalled stream write must not hold up the reset. */
const TERMINAL_EVENT_TIMEOUT_MS = 5_000;

const log = createLogger("execution.session-inbox");

/** What made eve end a stranded session; recorded for operators. */
export type StrandedSessionEndTrigger = "message" | "reset" | "timeout";

/**
 * The `session.ended` cause naming what ended a stranded session: `stranded-reset`,
 * `stranded-message`, or `stranded-timeout`.
 */
export function strandedEndPolicy(trigger: StrandedSessionEndTrigger): string {
  return `stranded-${trigger}`;
}

/**
 * Ends a stranded session without running any of its code, so none of its
 * terminal hooks fire: cancels its owner run and the original run that
 * anchors its stream, then waits until the World has released every address
 * the owner answered to so a fresh session can claim them. Ending cannot be
 * undone, so each one is logged for operators. Returns the ended session's id.
 * Does not discover or cancel descendants: their handles live in the
 * session's state, which only its own code reads. The replay guard retires
 * incompatible subagent and workflow tool runs when their deliveries arrive;
 * timers remain runnable.
 *
 * Every step tolerates a previous or concurrent attempt having done it
 * already, so a request that fails part way can simply be retried. Concurrent
 * attempts are not arbitrated: each may publish and cancel independently.
 */
export async function endStrandedSession(
  stranded: StrandedSessionOwnerError,
  /** The address the caller used; a session address names the session outright. */
  address: string | SessionInboxAddress,
  trigger: StrandedSessionEndTrigger,
): Promise<string> {
  const sessionId =
    typeof address === "string" ? await resolveStrandedSessionId(stranded) : address.sessionId;
  const { ownerRunId } = stranded;
  const world = await getWorld();
  await assertStillServesSession(sessionId, ownerRunId);
  // Listed before cancelling: a cancelled run's hooks are disposed and no longer listed.
  const ownedTokens = await listOwnedSessionTokens(world, ownerRunId);
  // Publish before cancellation can expire zero-retention data.
  await publishTerminalEvent(sessionId, trigger);
  // The session id is the original run; after a handoff it parks as the stream anchor.
  await cancelRuns(world, [ownerRunId, sessionId], "Session ended: its deployment was retired");
  await waitForSessionHooksRelease(
    [sessionCommandHookToken(sessionId), logicalSessionToken(address), ...ownedTokens],
    ownerRunId,
  );
  log.warn("Reset stranded session", {
    currentEveVersion: resolveInstalledPackageInfo().version,
    previousEveVersion: stranded.eveVersion ?? "unknown",
    previousSessionId: sessionId,
    trigger,
  });
  return sessionId;
}

/**
 * Refuses to touch a session whose stable inbox another run took over since
 * ingress inspected it: cancelling the anchor would end a session a newer
 * owner still serves.
 */
async function assertStillServesSession(sessionId: string, ownerRunId: string): Promise<void> {
  const holder = await findSessionHookHolder(
    sessionInboxHookToken(sessionCommandHookToken(sessionId)),
  );
  // Released: an earlier attempt cancelled the owner, or it was mid-handoff.
  if (holder === undefined) return;
  if (holder.runId !== ownerRunId) {
    throw new Error(
      `Session "${sessionId}" changed owners while it was being reset. Nothing was ended; retry the request.`,
    );
  }
}

/**
 * Appends `session.ended` and closes the stream without running authored
 * hooks. Unavailable payload keys, an already-closed stream, or a stalled
 * write must not prevent the reset.
 */
async function publishTerminalEvent(
  sessionId: string,
  trigger: StrandedSessionEndTrigger,
): Promise<void> {
  const writer = getRun(sessionId).getWritable<Uint8Array>().getWriter();
  const publication = (async () => {
    // A replacement reading this history skips it when a reset ended the session.
    const ended: SessionEvent = {
      data: {
        cause: { policy: strandedEndPolicy(trigger) },
        error: { code: "session_stranded", message: "This session is no longer available." },
        outcome: "failed",
      },
      type: "session.ended",
    };
    await writer.write(
      new TextEncoder().encode(encodeLine({ at: new Date().toISOString(), facts: [ended] })),
    );
    await writer.close();
    return true;
  })();
  // Settles after the reset moves on when the write stalls.
  publication.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), TERMINAL_EVENT_TIMEOUT_MS);
  });
  try {
    if (!(await Promise.race([publication, timeout]))) {
      log.warn("Timed out finishing the stranded session stream", { sessionId });
    }
  } catch {
    log.warn("Could not finish the stranded session stream", { sessionId });
  } finally {
    clearTimeout(timer);
    writer.releaseLock();
  }
}

/** Cancels exactly these runs; one that already ended counts as cancelled. */
async function cancelRuns(
  world: World,
  runIds: readonly string[],
  cancelReason: string,
): Promise<void> {
  for (const runId of new Set(runIds)) {
    try {
      await cancelRun(world, runId, { cancelReason });
    } catch (error) {
      if (!isInactiveWorkflowRunError(error)) throw error;
    }
  }
}

/**
 * Public id of the session a stranded owner reached through a channel address
 * serves. Initial owners are their own session and successors record theirs,
 * but successors from builds that predate `$eve.session` name it only in
 * their encrypted hook metadata. Guessing would cancel the wrong anchor, so an
 * unknown session fails.
 */
async function resolveStrandedSessionId(stranded: StrandedSessionOwnerError): Promise<string> {
  const { attributes, runId } = stranded.ownerRun;
  const recorded = attributes[EVE_SESSION_ATTRIBUTE];
  if (recorded !== undefined) return recorded;
  if (stranded.hook !== undefined) {
    try {
      return requireSessionId(await stranded.hook.metadata);
    } catch {
      // A stranded owner's payload key may be gone; the plaintext record may still name it.
    }
  }
  // Only a run started as a session carries `$eve.type`; handoff successors start without it.
  if (attributes[EVE_TYPE_ATTRIBUTE] !== undefined) return runId;
  throw new Error(
    `Cannot reset stranded session owner run "${runId}": it does not record which session it serves. Cancel the run directly.`,
  );
}

/** Logical session addresses the owner holds. Hook tokens are plaintext, so no payload is decrypted. */
async function listOwnedSessionTokens(world: World, ownerRunId: string): Promise<string[]> {
  const tokens: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HOOK_PAGES; page++) {
    const hooks = await world.hooks.list({
      pagination: { cursor, limit: HOOK_PAGE_LIMIT },
      resolveData: "none",
      runId: ownerRunId,
    });
    for (const hook of hooks.data) {
      const token = logicalSessionInboxToken(hook.token);
      if (token !== undefined) tokens.push(token);
    }
    if (!hooks.hasMore || hooks.cursor === null) break;
    cursor = hooks.cursor;
  }
  return tokens;
}
