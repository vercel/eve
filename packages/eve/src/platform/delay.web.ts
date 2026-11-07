import type { delay as NodeTwin } from "./delay.js";

// A wait that an `AbortSignal` cuts short, where there's no `node:timers`. It rejects as Node's
// does: an `AbortError` with the signal's reason as its `cause`. `delay.ts` is the Node twin.

function abortError(signal: AbortSignal): Error {
  const error = new Error("The operation was aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

export const delay: typeof NodeTwin = (ms, signal) => {
  if (signal?.aborted === true) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      if (signal !== undefined) reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};
