import { shutdownActiveSandboxConnections } from "#execution/sandbox/active-connections.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { currentPlatform } from "#platform/current.js";

const SANDBOX_SHUTDOWN_TIMEOUT_MS = 15_000;

interface NitroAppLike {
  readonly hooks?: {
    hook(name: "close", handler: () => Promise<void>): unknown;
  };
}

export function shouldInstallSandboxShutdown(env: Record<string, string | undefined>): boolean {
  if (isEveDevEnvironment()) {
    return false;
  }
  if (env.EVE_DEVELOPMENT_SANDBOX_RUN_ID !== undefined) {
    return false;
  }
  if (currentPlatform().deployment.host() === "vercel") {
    return false;
  }
  return true;
}

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
