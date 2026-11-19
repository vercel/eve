import { NodeWorkerEnvRunner } from "#compiled/env-runner/index.js";
import { fileURLToPath } from "node:url";

import { resolvePackageCompiledFilePath } from "#internal/application/package.js";

const DEVELOPMENT_WORKER_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface EveDevRunnerInput {
  readonly entry: string;
  readonly name: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

export class EveDevRunner extends NodeWorkerEnvRunner {
  readonly #terminated = Promise.withResolvers<void>();
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
