import { toErrorMessage } from "#shared/errors.js";

interface ActiveSandboxConnection {
  stop(): Promise<void>;
}

const activeSandboxConnections = new Map<string, ActiveSandboxConnection>();

interface ActiveSandboxConnectionKey {
  readonly providerName: string;
  readonly sessionId: string;
}

function createKey(input: ActiveSandboxConnectionKey): string {
  return `${input.providerName}\0${input.sessionId}`;
}

export function trackActiveSandboxConnection(
  input: ActiveSandboxConnectionKey & { readonly connection: ActiveSandboxConnection },
): void {
  activeSandboxConnections.set(createKey(input), input.connection);
}

export function untrackActiveSandboxConnection(
  input: ActiveSandboxConnectionKey & { readonly connection?: ActiveSandboxConnection },
): void {
  const key = createKey(input);
  if (input.connection === undefined || activeSandboxConnections.get(key) === input.connection) {
    activeSandboxConnections.delete(key);
  }
}

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
