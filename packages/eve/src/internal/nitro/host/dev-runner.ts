import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { BaseEnvRunner } from "#compiled/env-runner/index.js";
import { resolvePackageCompiledFilePath } from "#internal/application/package.js";

// The outer dev-server process grants its child 550ms to close over IPC before
// escalating to process signals. Keep worker cleanup inside that window while
// still giving Nitro hooks enough time to release worker-owned resources.
const DEVELOPMENT_WORKER_SHUTDOWN_GRACE_MS = 300;

export interface DevelopmentRunner {
  readonly closed: boolean;
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

class NodeDevelopmentRunner extends BaseEnvRunner implements DevelopmentRunner {
  #closeCause: unknown;
  readonly #closedListeners = new Set<(cause?: unknown) => void>();
  #worker: Worker | undefined;

  constructor(input: DevelopmentRunnerInput) {
    const workerEntry = resolvePackageCompiledFilePath("src/compiled/env-runner/node-worker.js");
    super({
      data: {
        entry: input.entry,
        ...input.workerData,
      },
      hooks: {
        onClose: (_runner, cause) => {
          const listeners = [...this.#closedListeners];
          this.#closedListeners.clear();
          for (const listener of listeners) {
            listener(cause);
          }
        },
      },
      name: input.name,
      workerEntry,
    });
    this._initWithVirtualData(() => this.#startWorker());
  }

  onceClosed(listener: (cause?: unknown) => void): void {
    if (this.closed) {
      listener(this.#closeCause);
      return;
    }
    this.#closedListeners.add(listener);
  }

  override sendMessage(message: unknown): void {
    if (this.#worker === undefined) {
      throw new Error("Development worker is not initialized.");
    }
    this.#worker.postMessage(message);
  }

  override async waitForReady(timeout: number): Promise<void> {
    try {
      await super.waitForReady(timeout);
    } catch (error) {
      if (this.#closeCause === undefined) {
        throw error;
      }
      throw new Error(
        `Development worker failed before readiness: ${this.#closeCause instanceof Error ? this.#closeCause.message : String(this.#closeCause)}`,
        { cause: this.#closeCause },
      );
    }
  }

  protected override _hasRuntime(): boolean {
    return this.#worker !== undefined;
  }

  protected override _runtimeType(): string {
    return "worker";
  }

  protected override async _closeRuntime(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) {
      return;
    }

    this.#worker = undefined;
    await requestWorkerShutdown(worker);
    worker.removeAllListeners();
    const ignoreTerminationError = () => undefined;
    worker.on("error", ignoreTerminationError);
    try {
      await worker.terminate();
    } finally {
      worker.off("error", ignoreTerminationError);
    }
  }

  protected override _handleMessage(message: unknown): void {
    if (isWorkerInitializationError(message)) {
      this.#closeCause = new Error(message.error);
    }
    super._handleMessage(message);
  }

  #startWorker(): void {
    if (!existsSync(this._workerEntry)) {
      void this.close(`Development worker entry not found at "${this._workerEntry}".`);
      return;
    }

    const worker = new Worker(this._workerEntry, {
      env: process.env,
      workerData: {
        name: this._name,
        ...this._data,
      },
    });
    this.#worker = worker;
    worker.once("error", (error) => {
      this.#closeCause = error;
      void this.close(error);
    });
    worker.once("exit", (code) => {
      const error = new Error(`Development worker exited with code ${String(code)}.`);
      this.#closeCause ??= error;
      void this.close(error);
    });
    worker.on("message", (message: unknown) => this._handleMessage(message));
  }
}

export const createNodeDevelopmentRunner: DevelopmentRunnerFactory = (input) =>
  new NodeDevelopmentRunner(input);

async function requestWorkerShutdown(worker: Worker): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      worker.off("error", settle);
      worker.off("exit", settle);
      worker.off("message", onMessage);
      resolve();
    };
    const onMessage = (message: unknown) => {
      if (isWorkerExitMessage(message)) {
        settle();
      }
    };

    worker.once("error", settle);
    worker.once("exit", settle);
    worker.on("message", onMessage);
    timeout = setTimeout(settle, DEVELOPMENT_WORKER_SHUTDOWN_GRACE_MS);
    timeout.unref();

    if (worker.threadId === -1) {
      settle();
      return;
    }

    try {
      worker.postMessage({ event: "shutdown" });
    } catch {
      settle();
    }
  });
}

function isWorkerExitMessage(value: unknown): value is { readonly event: "exit" } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (value as Record<string, unknown>).event === "exit";
}

function isWorkerInitializationError(
  value: unknown,
): value is { readonly error: string; readonly event: "init-error" } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.event === "init-error" && typeof record.error === "string";
}
