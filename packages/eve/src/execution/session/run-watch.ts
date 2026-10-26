import { sleep } from "#compiled/@workflow/core/index.js";

import { hasRunEndedStep } from "#execution/session/handoff-steps.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";

/** Long enough that a handoff settling normally never pays for a check. */
const RUN_WATCH_INTERVAL = "10s";

export interface RunWatch {
  /** Resolves once the run has ended; never settles once stopped. */
  readonly ended: Promise<void>;
  stop(): void;
}

/**
 * Watches a counterpart run so a wait on it has a way out when that run is
 * gone. Durable sleeps between checks keep it deterministic under replay;
 * `stop()` ends it before its next check.
 */
export function watchRunEnd(runId: string): RunWatch {
  let stopped = false;
  const ended = (async () => {
    while (!stopped) {
      await sleep(RUN_WATCH_INTERVAL);
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
 * before its handover arrives: an ended run can never send it. The watch
 * starts only once a read waits on the gate, so a handover that arrives
 * before it is needed costs nothing.
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
