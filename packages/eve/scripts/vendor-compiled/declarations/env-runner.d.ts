import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

// The subset of env-runner's `runners/node-worker` surface eve uses.

export interface WorkerHooks {
  onClose?(runner: NodeWorkerEnvRunner, cause?: unknown): void;
  onReady?(runner: NodeWorkerEnvRunner): void;
}

export interface NodeWorkerEnvRunnerOptions {
  readonly data?: Record<string, unknown>;
  readonly hooks?: WorkerHooks;
  readonly name: string;
  readonly workerEntry?: string;
}

export class NodeWorkerEnvRunner {
  readonly closed: boolean;
  readonly ready: boolean;

  constructor(options: NodeWorkerEnvRunnerOptions);

  close(cause?: unknown): Promise<void>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /**
   * Shuts down gracefully, then closes: the worker stops accepting
   * connections, waits for in-flight requests for half of `timeout` at most,
   * and runs the entry's `ipc.onClose`. Closes right away when the worker is
   * not ready, and after `timeout` at the latest.
   */
  shutdown(timeout?: number): Promise<void>;
  upgrade(context: {
    node: { head: Uint8Array; req: IncomingMessage; socket: Socket };
  }): Promise<void>;
  /** Rejects on timeout, and as soon as the runner closes, with the close cause. */
  waitForReady(timeout?: number): Promise<void>;
}
