import { NodeWorkerEnvRunner } from "#compiled/env-runner/index.js";
import { fileURLToPath } from "node:url";

import { resolvePackageCompiledFilePath } from "#internal/application/package.js";

/** In-flight requests get half of this, then Nitro's close hooks run. */
const DEVELOPMENT_WORKER_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface EveDevRunnerInput {
  readonly entry: string;
  readonly name: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

/**
 * Runs a Nitro development entry in a worker thread. `close()` without a
 * cause shuts down gracefully, so admitted requests settle and Nitro's close
 * hooks run; with a cause it stops at once.
 */
export class EveDevRunner extends NodeWorkerEnvRunner {
  readonly #terminated = Promise.withResolvers<void>();
  /** Settles once the worker thread is gone, so its host's files can go too. */
  readonly terminated = this.#terminated.promise;

  constructor(input: EveDevRunnerInput) {
    super({
      data: { entry: input.entry, ...input.workerData },
      name: input.name,
      workerEntry: import.meta.url.endsWith(".ts")
        ? resolvePackageCompiledFilePath("src/compiled/env-runner/node-worker.js")
        : fileURLToPath(new URL("./dev-worker-entry.js", import.meta.url)),
    });
  }

  #shuttingDown = false;

  override async close(cause?: unknown): Promise<void> {
    // `shutdown()` ends with its own `close()`, which must stop immediately.
    if (cause === undefined && !this.closed && !this.#shuttingDown) {
      await this.shutdown();
      return;
    }
    const closing = !this.closed;
    await super.close(cause);
    if (closing) this.#terminated.resolve();
  }

  override async shutdown(timeout = DEVELOPMENT_WORKER_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.#shuttingDown = true;
    await super.shutdown(timeout);
  }
}
