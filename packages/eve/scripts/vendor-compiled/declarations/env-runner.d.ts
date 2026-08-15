import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

export interface WorkerHooks {
  onClose?(runner: BaseEnvRunner, cause?: unknown): void;
  onReady?(runner: BaseEnvRunner): void;
}

export interface BaseEnvRunnerOptions {
  readonly data?: Record<string, unknown>;
  readonly hooks?: WorkerHooks;
  readonly name: string;
  readonly workerEntry: string;
}

export class BaseEnvRunner {
  readonly closed: boolean;
  readonly ready: boolean;
  protected readonly _data: Record<string, unknown> | undefined;
  protected readonly _name: string;
  protected readonly _workerEntry: string;

  constructor(options: BaseEnvRunnerOptions);

  close(cause?: unknown): Promise<void>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  sendMessage(message: unknown): void;
  upgrade(context: {
    node: { head: Uint8Array; req: IncomingMessage; socket: Socket };
  }): Promise<void>;
  waitForReady(timeout?: number): Promise<void>;

  protected _closeRuntime(): Promise<void>;
  protected _handleMessage(message: unknown): void;
  protected _hasRuntime(): boolean;
  protected _initWithVirtualData(initialize: () => void): void;
  protected _runtimeType(): string;
}
