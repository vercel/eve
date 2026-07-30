import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";
import { toErrorMessage } from "#shared/errors.js";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

let installed = false;

interface ServerShutdownProcess {
  readonly env: Record<string, string | undefined>;
  exitCode?: string | number | null;
  once(event: ShutdownSignal, listener: () => void): unknown;
}

interface NitroAppLike {
  readonly hooks?: {
    callHook(name: "close"): Promise<void>;
  };
}

/**
 * Reports whether this process owns the self-hosted server shutdown lifecycle.
 *
 * Development workers delegate cleanup to the CLI parent. Vercel instances
 * may be recycled without retiring persistent session resources.
 */
export function shouldInstallServerShutdown(env: Record<string, string | undefined>): boolean {
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

function exitCodeForSignal(signal: ShutdownSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Routes process signals through Nitro's close lifecycle exactly once.
 *
 * srvx owns the HTTP server's graceful drain for these same signals. Setting
 * `exitCode` instead of calling `process.exit()` lets both independent cleanup
 * paths settle before Node exits naturally.
 */
export function installServerShutdownHandlers(input: {
  readonly log: (message: string) => void;
  readonly nitroApp?: NitroAppLike;
  readonly process: ServerShutdownProcess;
}): void {
  const closeHooks = input.nitroApp?.hooks;
  if (!shouldInstallServerShutdown(input.process.env) || closeHooks === undefined) {
    return;
  }

  let shutdownRequested = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    input.process.once(signal, () => {
      if (shutdownRequested) {
        return;
      }
      shutdownRequested = true;

      void Promise.resolve()
        .then(async () => {
          await closeHooks.callHook("close");
        })
        .catch((error: unknown) => {
          input.log(`eve: server shutdown failed: ${toErrorMessage(error)}`);
        })
        .finally(() => {
          input.process.exitCode = exitCodeForSignal(signal);
        });
    });
  }
}

export default function serverShutdownPlugin(nitroApp?: NitroAppLike): void {
  if (installed || nitroApp?.hooks === undefined) {
    return;
  }
  installed = true;
  installServerShutdownHandlers({
    log: (message) => console.error(message),
    nitroApp,
    process,
  });
}
