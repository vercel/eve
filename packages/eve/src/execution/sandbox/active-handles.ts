import { toErrorMessage } from "#shared/errors.js";

/**
 * The provider handle capability the shutdown registry needs.
 * Structural so handles of any session-options generic register without
 * variance friction.
 */
export interface ShutdownCapableSandboxHandle {
  shutdown(): Promise<void>;
}

/**
 * Process-level registry of live sandbox provider handles, keyed by
 * backend name and session key so repeated `create` calls for the same
 * session replace rather than accumulate entries.
 *
 * `ensureSandboxAccess` registers every handle it opens; the server
 * shutdown path drains the registry so no sandbox compute outlives the
 * eve server process.
 */
const activeSandboxHandles = new Map<string, ShutdownCapableSandboxHandle>();

function createActiveSandboxHandleKey(providerName: string, sessionKey: string): string {
  return `${providerName}\0${sessionKey}`;
}

/**
 * Registers a live sandbox handle for shutdown tracking. A handle
 * created later for the same backend and session key replaces the
 * previous entry.
 */
export function trackActiveSandboxHandle(input: {
  readonly providerName: string;
  readonly handle: ShutdownCapableSandboxHandle;
  readonly sessionKey: string;
}): void {
  activeSandboxHandles.set(
    createActiveSandboxHandleKey(input.providerName, input.sessionKey),
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
