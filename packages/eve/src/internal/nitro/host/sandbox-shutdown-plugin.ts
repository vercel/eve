import { shutdownActiveSandboxConnections } from "#execution/sandbox/active-connections.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";

/**
 * Bounds sandbox shutdown so a wedged provider cannot keep the server
 * process alive past the supervisor's kill grace (`eve start` waits 25s
 * before SIGKILL, which includes srvx's graceful close).
 */
const SANDBOX_SHUTDOWN_TIMEOUT_MS = 15_000;

interface NitroAppLike {
  readonly hooks?: {
    hook(name: "close", handler: () => Promise<void>): unknown;
  };
}

/**
 * Reports whether this server process owns sandbox shutdown.
 *
 * - `eve dev` workers are excluded: the dev CLI parent already stops
 *   dev-tagged sandboxes when the dev server closes.
 * - Vercel serverless instances are excluded: instance recycling is not
 *   a server stop, and persistent session sandboxes must keep serving
 *   later invocations.
 */
export function shouldInstallSandboxShutdown(env: Record<string, string | undefined>): boolean {
  if (isEveDevEnvironment()) {
    return false;
  }
  if (env.EVE_DEVELOPMENT_SANDBOX_RUN_ID !== undefined) {
    return false;
  }
  if (env.VERCEL !== undefined) {
    return false;
  }
  return true;
}

/**
 * Stops all tracked sandboxes, bounded by
 * {@link SANDBOX_SHUTDOWN_TIMEOUT_MS}. Never throws.
 */
export async function runSandboxShutdown(log: (message: string) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log("eve: sandbox shutdown timed out; continuing exit");
      resolve();
    }, SANDBOX_SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await Promise.race([shutdownActiveSandboxConnections({ log }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stops tracked sandboxes when the server closes. On SIGINT or SIGTERM,
 * srvx's graceful shutdown closes the server and Nitro runs its `close`
 * hooks; the process then exits on its own.
 */
export function installSandboxShutdown(input: {
  readonly env: Record<string, string | undefined>;
  readonly log: (message: string) => void;
  readonly nitroApp?: NitroAppLike;
}): void {
  if (!shouldInstallSandboxShutdown(input.env)) {
    return;
  }
  input.nitroApp?.hooks?.hook("close", async () => {
    await runSandboxShutdown(input.log);
  });
}

export default function sandboxShutdownPlugin(nitroApp?: NitroAppLike): void {
  installSandboxShutdown({
    env: process.env,
    log: (message) => console.error(message),
    nitroApp,
  });
}
