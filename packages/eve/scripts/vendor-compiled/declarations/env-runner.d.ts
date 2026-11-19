import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

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
  shutdown(timeout?: number): Promise<void>;
  upgrade(context: UpgradeContext): Promise<void>;
  waitForReady(timeout?: number): Promise<void>;
}

export interface RunnerReloadOptions {
  drain?: boolean | { timeout?: number };
}

export class RunnerManager {
  readonly ready: boolean;

  constructor(runner?: NodeWorkerEnvRunner);

  shutdown(timeout?: number): Promise<void>;
  fetch(input: Request, init?: RequestInit): Promise<Response>;
  onClose(listener: (manager: RunnerManager, cause?: unknown) => void): void;
  reload(runner: NodeWorkerEnvRunner, options?: RunnerReloadOptions): Promise<void>;
  upgrade(context: UpgradeContext): Promise<void>;
}
