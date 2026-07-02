import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Bounds sandbox shutdown so a wedged provider cannot keep the server
 * process alive past the supervisor's kill grace (`eve start` waits
 * 20s before SIGKILL).
 */
const SANDBOX_SHUTDOWN_TIMEOUT_MS = 15_000;

let installed = false;

interface SandboxShutdownProcess {
  readonly env: Record<string, string | undefined>;
  exit(code?: number): void;
  once(event: ShutdownSignal, listener: () => void): unknown;
}

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
    await Promise.race([shutdownActiveSandboxHandles({ log }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function exitCodeForSignal(signal: ShutdownSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Wires sandbox shutdown into the server lifecycle: the nitro `close`
 * hook plus SIGINT/SIGTERM, since the node-server preset installs no
 * signal handling of its own. Exposed for tests; the plugin default
 * export applies it to the real `process`.
 */
export function installSandboxShutdownHandlers(input: {
  readonly log: (message: string) => void;
  readonly nitroApp?: NitroAppLike;
  readonly process: SandboxShutdownProcess;
}): void {
  if (!shouldInstallSandboxShutdown(input.process.env)) {
    return;
  }

  input.nitroApp?.hooks?.hook("close", async () => {
    await runSandboxShutdown(input.log);
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    input.process.once(signal, () => {
      void runSandboxShutdown(input.log).finally(() => {
        input.process.exit(exitCodeForSignal(signal));
      });
    });
  }
}

export default function sandboxShutdownPlugin(nitroApp?: NitroAppLike): void {
  if (installed) {
    return;
  }
  installed = true;
  installSandboxShutdownHandlers({
    log: (message) => console.error(message),
    nitroApp,
    process,
  });
}
