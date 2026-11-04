import { setTimeout as nodeDelay } from "node:timers/promises";

// A wait that an `AbortSignal` cuts short: Node's own, which rejects with its `AbortError` (the
// signal's reason as its `cause`). `delay.web.ts` is the browser's twin; the package's
// `#platform/*` imports pick one by the `node` condition.

/** Resolves after `ms`; rejects once `signal` aborts. */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await nodeDelay(ms, undefined, { signal });
}
