import type { delay as NodeTwin } from "./delay.js";

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
