import type { SessionStore, SessionStoreSnapshot } from "eve/client";
export { interceptFetchOrigin } from "./fetch-interceptor.js";

/** Waits on the frontend's own stream, not another reader's progress or HTTP acceptance. */
export async function waitForStore(
  store: SessionStore,
  matches: (snapshot: SessionStoreSnapshot) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const waiting = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const check = () => {
    try {
      if (matches(store.snapshot)) resolve();
      else if (store.snapshot.error !== undefined) reject(store.snapshot.error);
    } catch (error) {
      reject(error);
    }
  };
  const abort = () => reject(waiting.reason);
  const unsubscribe = store.subscribe(check);
  waiting.addEventListener("abort", abort, { once: true });
  try {
    check();
    if (waiting.aborted) abort();
    await done;
  } finally {
    unsubscribe();
    waiting.removeEventListener("abort", abort);
  }
}
