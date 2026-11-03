import { NodeWorkerEnvRunner } from "#compiled/env-runner/index.js";
import { resolvePackageCompiledFilePath } from "#internal/application/package.js";
import { toErrorMessage } from "#shared/errors.js";

/** In-flight requests get half of this, then Nitro's close hooks run. */
const DEVELOPMENT_WORKER_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface DevelopmentRunner {
  readonly closed: boolean;
  /**
   * Retires the runner. Without a cause it shuts down gracefully, so admitted
   * requests settle and Nitro's close hooks run; with one it stops at once.
   */
  close(cause?: unknown): Promise<void>;
  fetch(request: Request, init?: RequestInit): Promise<Response>;
  onceClosed(listener: (cause?: unknown) => void): void;
  upgrade(input: {
    readonly node: {
      readonly head: Buffer;
      readonly req: import("node:http").IncomingMessage;
      readonly socket: import("node:net").Socket;
    };
  }): Promise<void>;
  waitForReady(timeout: number): Promise<void>;
}

export interface DevelopmentRunnerInput {
  readonly entry: string;
  readonly name: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

export type DevelopmentRunnerFactory = (input: DevelopmentRunnerInput) => DevelopmentRunner;

/** Runs a Nitro development entry in a worker thread through env-runner. */
export const createNodeDevelopmentRunner: DevelopmentRunnerFactory = (input) => {
  const closedListeners = new Set<(cause?: unknown) => void>();
  let closeCause: unknown;
  const runner = new NodeWorkerEnvRunner({
    data: { entry: input.entry, ...input.workerData },
    hooks: {
      onClose: (_runner, cause) => {
        closeCause = cause;
        const listeners = [...closedListeners];
        closedListeners.clear();
        for (const listener of listeners) listener(cause);
      },
    },
    name: input.name,
    workerEntry: resolvePackageCompiledFilePath("src/compiled/env-runner/node-worker.js"),
  });

  return {
    get closed() {
      return runner.closed;
    },
    close: async (cause) =>
      cause === undefined
        ? await runner.shutdown(DEVELOPMENT_WORKER_SHUTDOWN_TIMEOUT_MS)
        : await runner.close(cause),
    fetch: async (request, init) => await runner.fetch(request, init),
    onceClosed(listener) {
      if (runner.closed) {
        listener(closeCause);
        return;
      }
      closedListeners.add(listener);
    },
    upgrade: async (context) => await runner.upgrade(context),
    async waitForReady(timeout) {
      try {
        await runner.waitForReady(timeout);
      } catch (error) {
        throw new Error(`Development worker failed before readiness: ${toErrorMessage(error)}`, {
          cause: error,
        });
      }
    },
  };
};
