import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { shouldInstallServerShutdown } from "#internal/nitro/host/server-shutdown-plugin.js";

/**
 * Bounds sandbox shutdown so a wedged provider cannot keep the server
 * process alive past the supervisor's kill grace (`eve start` waits
 * 20s before SIGKILL).
 */
const SANDBOX_SHUTDOWN_TIMEOUT_MS = 15_000;

let installed = false;

interface NitroAppLike {
  readonly hooks?: {
    hook(name: "close", handler: () => Promise<void>): unknown;
  };
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

/**
 * Wires tracked sandbox cleanup into Nitro's coordinated close lifecycle.
 */
export function installSandboxShutdownHook(input: {
  readonly env: Record<string, string | undefined>;
  readonly log: (message: string) => void;
  readonly nitroApp?: NitroAppLike;
}): void {
  if (!shouldInstallServerShutdown(input.env)) {
    return;
  }

  input.nitroApp?.hooks?.hook("close", async () => {
    await runSandboxShutdown(input.log);
  });
}

export default function sandboxShutdownPlugin(nitroApp?: NitroAppLike): void {
  if (installed) {
    return;
  }
  installed = true;
  installSandboxShutdownHook({
    env: process.env,
    log: (message) => console.error(message),
    nitroApp,
  });
}
