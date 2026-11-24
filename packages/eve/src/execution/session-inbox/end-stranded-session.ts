import { builtInHosts } from "#runtime/app.js";
import type { SessionControlIdentity } from "#channel/types.js";
import { principalOf } from "#execution/session/delivery-facts.js";
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
import { logicalSessionToken } from "#execution/session-inbox/address.js";
import { requireSessionId } from "#execution/session-inbox/resume.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger } from "#internal/logging.js";
import { streamSessionEvents } from "#execution/session-event-stream.js";
import { createLineCommitter } from "#harness/session-machine/lines.js";
import { isRunInactive } from "#shared/run-errors.js";
import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import { endSession } from "#harness/session-machine/deliveries.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

type World = Awaited<ReturnType<typeof getWorld>>;

const HOOK_PAGE_LIMIT = 100;
const MAX_HOOK_PAGES = 10;
const TERMINAL_EVENT_TIMEOUT_MS = 5_000;
const HISTORY_READ_TIMEOUT_MS = 30_000;

const log = createLogger("execution.session-inbox");

export type StrandedSessionEndTrigger = "message" | "reset" | "timeout";

export function strandedEndPolicy(trigger: StrandedSessionEndTrigger): string {
  return `stranded-${trigger}`;
}

export async function endStrandedSession(
  stranded: StrandedSessionOwnerError,
  address: string | SessionInboxAddress,
  trigger: StrandedSessionEndTrigger,
  control?: SessionControlIdentity,
): Promise<string> {
  if (trigger === "reset" && control === undefined)
    throw new Error("A stranded reset requires its control delivery identity.");
  const sessionId =
    typeof address === "string" ? await resolveStrandedSessionId(stranded) : address.sessionId;
  const { ownerRunId } = stranded;
  const world = await getWorld();
  await assertStillServesSession(sessionId, ownerRunId);
  const ownedTokens = await listOwnedSessionTokens(world, ownerRunId);
  await publishTerminalEvent(sessionId, trigger, control);
  await cancelRuns(world, [ownerRunId, sessionId], "Session ended: its deployment was retired");
  await waitForSessionHooksRelease(
    [sessionCommandHookToken(sessionId), logicalSessionToken(address), ...ownedTokens],
    { ownerRunId, sessionId },
  );
  log.warn("Reset stranded session", {
    currentEveVersion: resolveInstalledPackageInfo().version,
    previousEveVersion: stranded.eveVersion ?? "unknown",
    previousSessionId: sessionId,
    trigger,
  });
  return sessionId;
}

async function assertStillServesSession(sessionId: string, ownerRunId: string): Promise<void> {
  const holder = await findSessionHookHolder(
    sessionInboxHookToken(sessionCommandHookToken(sessionId)),
  );
  if (holder === undefined) return;
  if (holder.runId !== ownerRunId) {
    throw new Error(
      `Session "${sessionId}" changed owners while it was being reset. Nothing was ended; retry the request.`,
    );
  }
}

async function publishTerminalEvent(
  sessionId: string,
  trigger: StrandedSessionEndTrigger,
  control?: SessionControlIdentity,
): Promise<void> {
  const view = await readRecordedView(sessionId);
  if (view === undefined) return;
  const writer = getRun(sessionId).getWritable<Uint8Array>().getWriter();
  const publication = (async () => {
    const facts = endSession(
      { view },
      {
        cause: control === undefined ? { policy: strandedEndPolicy(trigger) } : undefined,
        control:
          control === undefined
            ? undefined
            : { deliveryId: control.deliveryId, principal: principalOf(control.auth) },
        error: { code: "session_stranded", message: "This session is no longer available." },
        outcome: "failed",
      },
    );
    const lines = (await createLineCommitter()).commit(view, facts, view.position);
    for (const { bytes } of lines) await writer.write(bytes);
    await writer.close();
    return true;
  })();
  publication.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), TERMINAL_EVENT_TIMEOUT_MS);
  });
  try {
    if (!(await Promise.race([publication, timeout]))) {
      log.warn("Timed out finishing the stranded session stream", { sessionId });
    }
  } catch (error) {
    log.warn("Could not finish the stranded session stream", { error, sessionId });
  } finally {
    clearTimeout(timer);
    writer.releaseLock();
  }
}

async function readRecordedView(sessionId: string): Promise<SessionView | undefined> {
  const view = emptySessionView();
  const controller = new AbortController();
  const read = (async () => {
    for await (const event of streamSessionEvents(builtInHosts(), sessionId, {
      follow: false,
      signal: controller.signal,
    })) {
      foldReceivedEvent(view, event);
    }
  })();
  read.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), HISTORY_READ_TIMEOUT_MS);
  });
  let timedOut: boolean;
  try {
    timedOut = !(await Promise.race([read.then(() => true), timeout]));
  } catch (error) {
    log.warn("Could not read the stranded session history", { error, sessionId });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    controller.abort();
    throw new Error(
      `Timed out reading the history of stranded session "${sessionId}". Nothing was ended; retry the request.`,
    );
  }
  return view;
}

async function cancelRuns(
  world: World,
  runIds: readonly string[],
  cancelReason: string,
): Promise<void> {
  for (const runId of new Set(runIds)) {
    try {
      await cancelRun(world, runId, { cancelReason });
    } catch (error) {
      if (!isRunInactive(error)) throw error;
    }
  }
}

export async function resolveStrandedSessionId(
  stranded: StrandedSessionOwnerError,
): Promise<string> {
  const { attributes, runId } = stranded.ownerRun;
  const recorded = attributes[EVE_SESSION_ATTRIBUTE];
  if (recorded !== undefined) return recorded;
  if (stranded.hook !== undefined) {
    try {
      return requireSessionId(await stranded.hook.metadata);
    } catch {}
  }
  if (attributes[EVE_TYPE_ATTRIBUTE] !== undefined) return runId;
  throw new Error(
    `Cannot reset stranded session owner run "${runId}": it does not record which session it serves. Cancel the run directly.`,
  );
}

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
