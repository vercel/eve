import type {
  SessionTimeoutControl,
  SessionTimeoutInput,
} from "#execution/session/timeout-control.js";

export function clockSessionTimeoutControl(
  now: () => number,
  input: SessionTimeoutInput,
): SessionTimeoutControl | undefined {
  const { timeoutMs } = input;
  if (timeoutMs === false) return undefined;
  let lastActivityAt = input.deadline === undefined ? now() : input.deadline.getTime() - timeoutMs;
  return {
    getDeadline: () => new Date(lastActivityAt + timeoutMs),
    dispose: async () => {},
    handleTimerElapsed: async () => (now() >= lastActivityAt + timeoutMs ? "expired" : "extended"),
    recordActivity() {
      lastActivityAt = now();
    },
    start: async () => {},
  };
}
