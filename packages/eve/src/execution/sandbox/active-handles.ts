import { toErrorMessage } from "#shared/errors.js";

/**
 * The process-local shutdown operation the registry needs.
 */
export interface ShutdownCapableSandboxHandle {
  shutdown(): Promise<void>;
}

/**
 * Process-level registry of live sandboxes, keyed by provider protocol and
 * resource identity so repeated restoration replaces rather than accumulates
 * entries.
 *
 * `ensureSandboxAccess` registers every sandbox it opens; the server
 * shutdown path drains the registry so no sandbox compute outlives the
 * eve server process.
 */
const activeSandboxHandles = new Map<string, ShutdownCapableSandboxHandle>();

function createActiveSandboxHandleKey(provider: string, resourceId: string): string {
  return `${provider}\0${resourceId}`;
}

/**
 * Registers a live sandbox handle for shutdown tracking. A handle
 * created later for the same provider resource replaces the
 * previous entry.
 */
export function trackActiveSandboxHandle(input: {
  readonly provider: string;
  readonly handle: ShutdownCapableSandboxHandle;
  readonly resourceId: string;
}): void {
  activeSandboxHandles.set(
    createActiveSandboxHandleKey(input.provider, input.resourceId),
    input.handle,
  );
}

/**
 * Stops every tracked sandbox by calling `shutdown()` on each handle in
 * parallel, then clears the registry. Failures are logged and never
 * thrown so one misbehaving sandbox cannot block server shutdown.
 */
export async function shutdownActiveSandboxHandles(input?: {
  readonly log?: (message: string) => void;
}): Promise<void> {
  const entries = [...activeSandboxHandles.entries()];
  activeSandboxHandles.clear();

  const results = await Promise.allSettled(entries.map(([, handle]) => handle.shutdown()));

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const entry = entries[index];
      input?.log?.(
        `failed to shut down sandbox "${entry?.[0] ?? "unknown"}": ${toErrorMessage(result.reason)}`,
      );
    }
  }
}

/** Returns the number of tracked handles. Exposed for tests and logging. */
export function countActiveSandboxHandles(): number {
  return activeSandboxHandles.size;
}

export function clearActiveSandboxHandlesForTest(): void {
  activeSandboxHandles.clear();
}
