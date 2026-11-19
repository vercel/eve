import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.sandbox.vercel");

export function createVercelTimeout(sandbox: VercelSandbox) {
  const interval = Math.max(1, Math.min(60_000, Math.floor((sandbox.timeout ?? 30 * 60_000) / 3)));
  let active = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let request: AbortController | undefined;
  let retryAt = 0;
  let warned = false;

  async function extend(): Promise<void> {
    try {
      const timeout = sandbox.timeout;
      if (timeout === undefined || closed || active === 0 || Date.now() < retryAt) return;
      const session = sandbox.currentSession();
      if (session.status !== "running" && session.status !== "pending") return;
      const remaining =
        (session.startedAt ?? session.createdAt).getTime() + session.timeout - Date.now();
      if (remaining <= 0 || remaining > timeout / 2) return;
      retryAt = Date.now() + interval;
      const controller = new AbortController();
      request = controller;
      await session.extendTimeout(timeout - remaining, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(Math.min(10_000, interval)),
        ]),
      });
      warned = false;
    } catch (error) {
      if (request?.signal.aborted) {
        retryAt = 0;
      } else if (!warned) {
        warned = true;
        log.warn(
          "failed to extend an active Vercel sandbox's timeout; its current deadline still applies",
          {
            error,
            sandboxName: sandbox.name,
          },
        );
      }
    } finally {
      request = undefined;
    }
  }

  async function renew(): Promise<void> {
    await pending;
    return (pending ??= extend().finally(() => {
      pending = undefined;
    }));
  }

  function schedule(): void {
    if (closed || active === 0 || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void renew().then(schedule);
    }, interval);
    timer.unref();
  }

  async function acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (closed)
      throw new Error(
        "The Vercel sandbox connection is closed. Request the sandbox again before using it.",
      );
    active++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      if (--active === 0) {
        clearTimeout(timer);
        timer = undefined;
        request?.abort();
      }
    };
    signal?.addEventListener("abort", release, { once: true });
    await renew();
    schedule();
    if (closed) {
      release();
      throw new Error("The Vercel sandbox connection closed before the operation started.");
    }
    signal?.throwIfAborted();
    return release;
  }

  return {
    acquire,
    async run<Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
      const release = await acquire(signal);
      try {
        return await operation();
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      request?.abort();
      await pending;
    },
  };
}
