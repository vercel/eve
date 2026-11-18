import { isVercelRequestRejectedError } from "#execution/sandbox/bindings/vercel-errors.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.sandbox.vercel");

const EXTENSION_REQUEST_TIMEOUT_MS = 10_000;

const SMALLEST_EXTENSION_MS = 1_000;

const SMALLEST_RETRIED_EXTENSION_MS = 60_000;

const RENEWAL_SLACK_MS = 60_000;

function remainingMs(sandbox: VercelSandbox): number | undefined {
  const session = sandbox.currentSession();
  if (session.status !== "running" && session.status !== "pending") return undefined;
  return (session.startedAt ?? session.createdAt).getTime() + session.timeout - Date.now();
}

async function extendVercelSandboxTimeout(sandbox: VercelSandbox, durationMs: number) {
  const remaining = remainingMs(sandbox);
  if (remaining === undefined) return;
  let rejection: unknown;
  let extension = durationMs - remaining;
  while (extension >= SMALLEST_EXTENSION_MS) {
    try {
      await sandbox.currentSession().extendTimeout(extension, {
        signal: AbortSignal.timeout(EXTENSION_REQUEST_TIMEOUT_MS),
      });
      return;
    } catch (error) {
      if (!isVercelRequestRejectedError(error)) throw error;
      rejection = error;
      extension = Math.floor(extension / 2);
      if (extension < SMALLEST_RETRIED_EXTENSION_MS) break;
    }
  }
  if (rejection === undefined) return;
  throw new Error(
    `Vercel rejected every extension of sandbox "${sandbox.name}"'s timeout. The usual cause is that the session reached the plan's maximum duration. ` +
      "The sandbox stops when its current timeout runs out, its running processes end, and the next use resumes it from its files.",
    { cause: rejection },
  );
}

export interface VercelDeadline {
  keepRunning(durationMs: number): Promise<void>;
  renew(): Promise<void>;
}

export function createVercelDeadline(sandbox: VercelSandbox): VercelDeadline {
  let extensions: Promise<void> = Promise.resolve();
  let renewalFailed = false;
  const keepRunning = (durationMs: number): Promise<void> => {
    const extended = extensions.then(() => extendVercelSandboxTimeout(sandbox, durationMs));
    extensions = extended.catch(() => undefined);
    return extended;
  };
  return {
    keepRunning,
    async renew() {
      if (renewalFailed) return;
      try {
        const timeout = sandbox.timeout;
        if (timeout === undefined) return;
        const remaining = remainingMs(sandbox);
        if (remaining === undefined) return;
        if (remaining > timeout - Math.min(RENEWAL_SLACK_MS, timeout / 2)) return;
        await keepRunning(timeout);
      } catch (error) {
        renewalFailed = true;
        log.warn("failed to extend a Vercel sandbox's timeout while eve uses it", {
          error,
          sandboxName: sandbox.name,
        });
      }
    },
  };
}
