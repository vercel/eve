import type { SandboxConnection } from "#sandbox/provider.js";

const disposals = new WeakMap<SandboxConnection, () => Promise<void>>();

export function withSandboxConnectionDisposal<Connection extends SandboxConnection>(
  connection: Connection,
  dispose: () => Promise<void>,
): Connection {
  let pending: Promise<void> | undefined;
  disposals.set(connection, () => (pending ??= dispose()));
  return connection;
}

export function sandboxConnectionDisposal(
  connection: SandboxConnection,
): (() => Promise<void>) | undefined {
  return disposals.get(connection);
}
