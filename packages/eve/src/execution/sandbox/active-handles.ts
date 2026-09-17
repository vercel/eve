import { toErrorMessage } from "#shared/errors.js";

/**
 * The provider handle capability the shutdown registry needs.
 * Structural so handles of any session-options generic register without
 * variance friction.
 */
export interface ShutdownCapableSandboxHandle {
  onRuntimeShutdown(): Promise<void>;
}

/**
 * Process-level registry of live sandbox provider handles, keyed by
 * provider name and durable session ID so a resumed handle replaces the
 * previous handle for that session rather than accumulating entries.
 *
 * `ensureSandboxAccess` registers every handle it opens; the server
 * shutdown path drains the registry so no sandbox compute outlives the
 * eve server process.
 */
const activeSandboxHandles = new Map<string, ShutdownCapableSandboxHandle>();

function createActiveSandboxHandleKey(providerName: string, sessionId: string): string {
  return `${providerName}\0${sessionId}`;
}

/**
 * Registers a live sandbox handle for shutdown tracking. A later handle
 * for the same provider and durable session replaces the previous entry.
 */
export function trackActiveSandboxHandle(input: {
  readonly providerName: string;
  readonly handle: ShutdownCapableSandboxHandle;
  readonly sessionId: string;
}): void {
  activeSandboxHandles.set(
    createActiveSandboxHandleKey(input.providerName, input.sessionId),
    input.handle,
  );
}

/**
 * Stops every tracked sandbox by invoking its runtime-shutdown hook in
 * parallel, then clears the registry. Failures are logged and never
 * thrown so one misbehaving sandbox cannot block server shutdown.
 */
export async function shutdownActiveSandboxHandles(input?: {
  readonly log?: (message: string) => void;
}): Promise<void> {
  const entries = [...activeSandboxHandles.entries()];
  activeSandboxHandles.clear();

  const results = await Promise.allSettled(entries.map(([, handle]) => handle.onRuntimeShutdown()));

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
