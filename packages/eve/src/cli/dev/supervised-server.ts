/**
 * Shared supervision for a local development server that a command owns for
 * the length of its run (`eve dev`, `eve acp`). Both stop the server from two
 * directions — a shutdown signal and their own teardown — so both need the
 * close to be idempotent.
 */

import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";

/** Starts a local development server for `appRoot`. */
export type StartDevelopmentHost = (
  appRoot: string,
  options?: DevelopmentServerOptions,
) => DevelopmentServer;

/**
 * A one-shot close for the server `getServer` returns. The first call starts
 * the close and every later call awaits that same promise, so a stop signal
 * racing the command's own teardown cannot close twice. Resolves immediately
 * while the server has not been created yet, and swallows the close rejection
 * so an aborted start cannot surface as an unhandled rejection.
 */
export function createServerCloseLatch(
  getServer: () => DevelopmentServer | undefined,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    const server = getServer();
    if (server === undefined) return Promise.resolve();
    closePromise ??= server.close();
    void closePromise.catch(() => undefined);
    return closePromise;
  };
}

/** Loads the local server factory lazily, keeping it off the CLI's boot path. */
export async function loadStartDevelopmentHost(): Promise<StartDevelopmentHost> {
  return (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
}
