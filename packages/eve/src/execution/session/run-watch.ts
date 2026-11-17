import { sleep } from "#compiled/@workflow/core/index.js";

import { hasRunEndedStep } from "#execution/session/handoff-steps.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";

const RUN_WATCH_INTERVAL = "10s";

export interface RunWatch {
  readonly ended: Promise<void>;
  stop(): void;
}

export function watchRunEnd(runId: string): RunWatch {
  let stopped = false;
  const ended = (async () => {
    for (let first = true; !stopped; first = false) {
      if (!first) await sleep(RUN_WATCH_INTERVAL);
      if (stopped) break;
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
