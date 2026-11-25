const LONGEST_TIMER_MS = 2 ** 31 - 1;

export function wakeAt(at: number, wake: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const delay = Math.max(0, at - Date.now());
    timer = setTimeout(delay > LONGEST_TIMER_MS ? arm : wake, Math.min(delay, LONGEST_TIMER_MS));
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
}

export interface WakeClock {
  now(): number;
  wakeAt(at: number, wake: () => void): () => void;
  advance(ms: number): void;
}

export function wakeClock(earlyMs = 0): WakeClock {
  let offset = 0;
  const timers = new Set<{ readonly at: number; readonly wake: () => void; stop: () => void }>();
  const arm = (timer: { readonly at: number; readonly wake: () => void; stop: () => void }) => {
    timer.stop = wakeAt(timer.at - offset - earlyMs, () => {
      timers.delete(timer);
      timer.wake();
    });
  };
  return {
    now: () => Date.now() + offset,
    wakeAt(at, wake) {
      const timer = { at, wake, stop: () => undefined };
      timers.add(timer);
      arm(timer);
      return () => {
        timers.delete(timer);
        timer.stop();
      };
    },
    advance(ms) {
      offset += ms;
      for (const timer of timers) {
        timer.stop();
        arm(timer);
      }
    },
  };
}
