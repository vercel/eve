import { toErrorMessage } from "#shared/errors.js";

/** A live connection the server stops, then closes, when it shuts down. */
interface ActiveSandboxConnection {
  stop(): Promise<void>;
}

/**
 * Process-level registry of live sandbox connections, keyed by provider name
 * and durable session ID so a resumed connection replaces the previous one
 * for that session rather than accumulating entries.
 *
 * `ensureSandboxAccess` registers the connections it opens; the server
 * shutdown path drains the registry so no sandbox compute outlives the eve
 * server process.
 */
const activeSandboxConnections = new Map<string, ActiveSandboxConnection>();

interface ActiveSandboxConnectionKey {
  readonly providerName: string;
  readonly sessionId: string;
}

function createKey(input: ActiveSandboxConnectionKey): string {
  return `${input.providerName}\0${input.sessionId}`;
}

/** Registers a live connection. A later one for the same provider and session replaces it. */
export function trackActiveSandboxConnection(
  input: ActiveSandboxConnectionKey & { readonly connection: ActiveSandboxConnection },
): void {
  activeSandboxConnections.set(createKey(input), input.connection);
}

/**
 * Drops `connection` from shutdown tracking, unless a newer one replaced it,
 * or whatever the session has tracked when `connection` is omitted.
 */
export function untrackActiveSandboxConnection(
  input: ActiveSandboxConnectionKey & { readonly connection?: ActiveSandboxConnection },
): void {
  const key = createKey(input);
  if (input.connection === undefined || activeSandboxConnections.get(key) === input.connection) {
    activeSandboxConnections.delete(key);
  }
}

/**
 * Stops every tracked connection in parallel, then clears the registry.
 * Failures are logged and never thrown so one misbehaving sandbox cannot
 * block server shutdown.
 */
export async function shutdownActiveSandboxConnections(input?: {
  readonly log?: (message: string) => void;
}): Promise<void> {
  const entries = [...activeSandboxConnections.entries()];
  activeSandboxConnections.clear();

  const results = await Promise.allSettled(entries.map(([, connection]) => connection.stop()));

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const entry = entries[index];
      input?.log?.(
        `failed to shut down sandbox "${entry?.[0] ?? "unknown"}": ${toErrorMessage(result.reason)}`,
      );
    }
  }
}
