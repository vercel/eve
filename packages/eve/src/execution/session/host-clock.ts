import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import type { SessionTurnHost, SessionWake } from "#execution/session/turn.js";

export const settleAll: SessionTurnHost["all"] = (work) => Promise.allSettled(work);

export function sessionHostClock(
  inbox: Pick<SessionInboxReader, "whenPending">,
  sleepUntil: (at: number) => Promise<void>,
): Pick<SessionTurnHost, "all" | "next" | "now"> {
  let window: { readonly at: number; readonly elapsed: Promise<SessionWake> } | undefined;
  return {
    all: settleAll,
    now: () => Date.now(),
    async next(options = {}) {
      const { until, wake } = options;
      const wakes: Promise<SessionWake>[] = [inbox.whenPending().then(() => "input" as const)];
      if (until !== undefined) {
        if (window?.at !== until)
          window = { at: until, elapsed: sleepUntil(until).then(() => "due" as const) };
        wakes.push(window.elapsed);
      }
      if (wake !== undefined) wakes.push(wake.then(() => "woken" as const));
      return await Promise.race(wakes);
    },
  };
}
