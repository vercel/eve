import { sleep } from "#compiled/@workflow/core/index.js";

import { hasRunEndedStep } from "#execution/session/handoff-steps.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";

/**
 * How long a watch waits between checks. An end that has not happened yet is
 * worth re-reading only occasionally: a counterpart that dies is noticed
 * within one interval, at one step's cost per interval.
 */
const RUN_WATCH_INTERVAL = "10s";

export interface RunWatch {
  /** Resolves once the run has ended; never settles once stopped. */
  readonly ended: Promise<void>;
  stop(): void;
}

/**
 * Watches a counterpart run so a wait on it has a way out when that run is
 * gone. It checks once before its first sleep, so a run that is already gone
 * is noticed at once, then sleeps between checks; durable sleeps keep the
 * repeated checks deterministic under replay, and `stop()` ends the watch
 * before its next check.
 */
export function watchRunEnd(runId: string): RunWatch {
  let stopped = false;
  const ended = (async () => {
    for (let first = true; !stopped; first = false) {
      if (!first) await sleep(RUN_WATCH_INTERVAL);
      if (stopped) break;
      // A check that fails says nothing about the run; try again later.
      const ended = await hasRunEndedStep({ runId }).catch(() => false);
      if (ended && !stopped) return;
    }
    return await new Promise<never>(() => {});
  })();
  return {
    ended,
    stop() {
      stopped = true;
    },
  };
}

/**
 * Opens the inbox's handover gate with nothing restored if `sourceRunId` ends
 * before its handover arrives: an ended run can never finish sending one. The
 * first check runs as soon as a read waits on the gate, so a source that was
 * already gone when this run booted costs no wait; a handover that arrives
 * before then costs nothing because no read waited. A part the source managed
 * to send before it ended still reaches the inbox, which keeps it.
 */
export function abandonHandoverIfRunEnds(
  inbox: SessionInboxHandle,
  handover: { readonly attemptKey: string; readonly sourceRunId: string },
): void {
  void inbox.whenBlockedOnHandover().then(() => {
    if (!inbox.awaitingHandover) return;
    const watch = watchRunEnd(handover.sourceRunId);
    void inbox.whenHandoverSettled().then(() => watch.stop());
    void watch.ended.then(() => inbox.abandonHandover(handover.attemptKey));
  });
}
