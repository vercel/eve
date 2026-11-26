import type {
  LocalDevScheduleClaim,
  LocalDevScheduleStore,
} from "#internal/schedules/local-dev-store.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

export function startLocalDevScheduleTimer(input: {
  readonly store: LocalDevScheduleStore;
  readonly dispatch: (claim: LocalDevScheduleClaim) => Promise<void>;
  readonly now?: () => number;
}): { stop(): void } {
  const now = input.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped) return;
    const next = input.store.earliestFireAtMs();
    if (next === null) return;
    timer = setTimeout(fire, Math.min(Math.max(0, next - now()), MAX_TIMEOUT_MS));
    timer.unref();
  };
  const fire = () => {
    timer = undefined;
    if (stopped) return;
    const claims = input.store.claimDue(now());
    arm();
    for (const claim of claims) void input.dispatch(claim);
  };

  const unsubscribe = input.store.onChange(arm);
  arm();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
    },
  };
}
