import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

// The subset of env-runner's public surface eve uses: `RunnerManager` from the
// package entry and `NodeWorkerEnvRunner` from `runners/node-worker`.

export interface UpgradeContext {
  node: { head: Uint8Array; req: IncomingMessage; socket: Socket };
}

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
  upgrade(context: UpgradeContext): Promise<void>;
  /** Rejects on timeout, and as soon as the runner closes, with the close cause. */
  waitForReady(timeout?: number): Promise<void>;
}

export interface RunnerReloadOptions {
  /**
   * Keep the previous runner serving the requests and WebSockets it already
   * accepted, and `shutdown()` it once they settle. It is closed after
   * `timeout` ms (default `60_000`; `Infinity` for no limit).
   */
  drain?: boolean | { timeout?: number };
}

/**
 * Proxies one active runner. Counts the requests (until their response body
 * settles) and WebSockets each runner serves, so a runner replaced with
 * `drain` retires once its own exchanges settle.
 */
export class RunnerManager {
  /** Whether a runner is attached and ready. */
  readonly ready: boolean;

  constructor(runner?: NodeWorkerEnvRunner);

  /** Shuts the active runner, and every draining one, down gracefully. */
  shutdown(timeout?: number): Promise<void>;
  fetch(input: Request, init?: RequestInit): Promise<Response>;
  /**
   * Called when the attached runner closes on its own, such as a crash. The
   * listener receives the manager, not the runner.
   */
  onClose(listener: (manager: RunnerManager, cause?: unknown) => void): void;
  /** Attaches `runner` right away; the previous runner retires as `drain` says. */
  reload(runner: NodeWorkerEnvRunner, options?: RunnerReloadOptions): Promise<void>;
  upgrade(context: UpgradeContext): Promise<void>;
}
