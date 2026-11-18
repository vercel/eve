import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.sandbox.vercel");

const EXTENSION_REQUEST_TIMEOUT_MS = 10_000;

const RENEWAL_SLACK_MS = 60_000;

function remainingMs(sandbox: VercelSandbox): number | undefined {
  const session = sandbox.currentSession();
  if (session.status !== "running" && session.status !== "pending") return undefined;
  return (session.startedAt ?? session.createdAt).getTime() + session.timeout - Date.now();
}

export interface VercelDeadline {
  renew(): Promise<void>;
}

export function createVercelDeadline(sandbox: VercelSandbox): VercelDeadline {
  let renewals: Promise<void> = Promise.resolve();
  let failed = false;
  async function renewOnce(): Promise<void> {
    if (failed) return;
    try {
      const timeout = sandbox.timeout;
      if (timeout === undefined) return;
      const remaining = remainingMs(sandbox);
      if (remaining === undefined) return;
      if (remaining > timeout - Math.min(RENEWAL_SLACK_MS, timeout / 2)) return;
      await sandbox.currentSession().extendTimeout(timeout - remaining, {
        signal: AbortSignal.timeout(EXTENSION_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      failed = true;
      log.warn(
        "failed to extend a Vercel sandbox's timeout while eve uses it; the sandbox stops when its current timeout runs out",
        { error, sandboxName: sandbox.name },
      );
    }
  }
  return {
    renew() {
      renewals = renewals.then(renewOnce);
      return renewals;
    },
  };
}
