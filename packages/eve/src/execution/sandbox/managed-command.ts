import { randomUUID } from "node:crypto";

import type { SandboxProcess, SandboxSession } from "#shared/sandbox-session.js";
import {
  LINE_TRUNCATION_SUFFIX,
  MAX_LINE_LENGTH,
  truncateTail,
} from "#execution/sandbox/truncate-output.js";

export const MAX_MANAGED_SANDBOX_COMMANDS = 64;

export interface ManagedSandboxCommandObservation {
  readonly exitCode?: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

export interface ManagedSandboxCommand {
  readonly commandId: string;
  inspect(): Promise<ManagedSandboxCommandObservation>;
  inspectStatus(): Promise<{ readonly exitCode?: number }>;
  terminate(): Promise<void>;
}

export interface ManagedSandboxCommandBackend {
  readonly reconnectable?: boolean;
  start(command: string): Promise<ManagedSandboxCommandBackendProcess>;
  reconnect(commandId: string): Promise<ManagedSandboxCommandBackendProcess | null>;
}

export interface ManagedSandboxCommandBackendProcess {
  readonly commandId: string;
  readonly process: SandboxProcess;
}

const backends = new Map<string, ManagedSandboxCommandBackend>();
const registries = new Map<string, ManagedCommandRegistry>();

export function registerManagedSandboxCommandBackend(
  sandbox: SandboxSession,
  backend: ManagedSandboxCommandBackend,
): void {
  backends.set(sandbox.id, backend);
}

export function clearManagedSandboxCommands(sandboxId: string): void {
  registries.delete(sandboxId);
  backends.delete(sandboxId);
}

export function getManagedSandboxCommands(sandbox: SandboxSession): ManagedCommandRegistry {
  const backend = backends.get(sandbox.id) ?? createSpawnBackend(sandbox);
  const existing = registries.get(sandbox.id);
  if (existing !== undefined) {
    existing.backend = backend;
    return existing;
  }
  const registry = new ManagedCommandRegistry(backend);
  registries.set(sandbox.id, registry);
  return registry;
}

/** Whether a fresh Function invocation can reconnect to this backend's commands. */
export function canReconnectManagedSandboxCommands(sandbox: SandboxSession): boolean {
  return backends.get(sandbox.id)?.reconnectable === true;
}

function createSpawnBackend(sandbox: SandboxSession): ManagedSandboxCommandBackend {
  return {
    async start(command) {
      return { commandId: randomUUID(), process: await sandbox.spawn({ command }) };
    },
    async reconnect() {
      return null;
    },
  };
}

export class ManagedCommandRegistry {
  readonly #commands = new Map<string, SpawnedCommand>();
  readonly #starts = new Map<string, Promise<SpawnedCommand>>();
  #pendingStarts = 0;
  backend: ManagedSandboxCommandBackend;

  constructor(backend: ManagedSandboxCommandBackend) {
    this.backend = backend;
  }

  async start(input: {
    readonly command: string;
    readonly idempotencyKey: string;
  }): Promise<ManagedSandboxCommand> {
    const existing = this.#starts.get(input.idempotencyKey);
    if (existing !== undefined) return await existing;

    if (this.#commands.size + this.#pendingStarts >= MAX_MANAGED_SANDBOX_COMMANDS) {
      this.#pruneCompleted();
    }
    if (this.#commands.size + this.#pendingStarts >= MAX_MANAGED_SANDBOX_COMMANDS) {
      throw new Error(
        `This sandbox already tracks ${MAX_MANAGED_SANDBOX_COMMANDS} running commands. Terminate or wait for existing commands before starting another.`,
      );
    }

    this.#pendingStarts += 1;
    const start = this.backend
      .start(input.command)
      .then((process) => this.#track(process, input.idempotencyKey));
    this.#starts.set(input.idempotencyKey, start);
    try {
      return await start;
    } catch (error) {
      if (this.#starts.get(input.idempotencyKey) === start) {
        this.#starts.delete(input.idempotencyKey);
      }
      throw error;
    } finally {
      this.#pendingStarts -= 1;
    }
  }

  async get(commandId: string): Promise<ManagedSandboxCommand> {
    validateCommandId(commandId);
    const existing = this.#commands.get(commandId);
    if (existing !== undefined) return existing;

    const reconnected = await this.backend.reconnect(commandId);
    if (reconnected === null) {
      throw new Error(
        `Sandbox command "${commandId}" is unavailable. Its completion state is unknown; do not rerun it unless you first verify that retrying is safe.`,
      );
    }
    return this.#track(reconnected);
  }

  #track(process: ManagedSandboxCommandBackendProcess, idempotencyKey?: string): SpawnedCommand {
    const command = new SpawnedCommand(process, idempotencyKey, () => {
      if (this.#commands.get(process.commandId) === command) {
        this.#commands.delete(process.commandId);
      }
      if (idempotencyKey !== undefined) this.#starts.delete(idempotencyKey);
    });
    this.#commands.set(process.commandId, command);
    return command;
  }

  #pruneCompleted(): void {
    for (const command of this.#commands.values()) {
      if (!command.completed) continue;
      this.#commands.delete(command.commandId);
      if (command.idempotencyKey !== undefined) this.#starts.delete(command.idempotencyKey);
    }
  }
}

class SpawnedCommand implements ManagedSandboxCommand {
  readonly commandId: string;
  readonly idempotencyKey?: string;
  readonly #handle: SandboxProcess;
  readonly #remove: () => void;
  readonly #stderr = new TailOutputBuffer();
  readonly #stdout = new TailOutputBuffer();
  #exitCode: number | undefined;
  #failure: unknown;

  constructor(
    process: ManagedSandboxCommandBackendProcess,
    idempotencyKey: string | undefined,
    remove: () => void,
  ) {
    this.commandId = process.commandId;
    this.idempotencyKey = idempotencyKey;
    this.#handle = process.process;
    this.#remove = remove;
    const stdout = captureOutput(this.#handle.stdout, this.#stdout);
    const stderr = captureOutput(this.#handle.stderr, this.#stderr);
    void Promise.all([this.#handle.wait(), stdout, stderr]).then(
      ([result]) => {
        this.#exitCode = result.exitCode;
      },
      (error: unknown) => {
        this.#failure = error;
      },
    );
  }

  get completed(): boolean {
    return this.#exitCode !== undefined || this.#failure !== undefined;
  }

  async inspect(): Promise<ManagedSandboxCommandObservation> {
    this.#throwIfFailed();
    return {
      exitCode: this.#exitCode,
      stderr: this.#stderr.output,
      stdout: this.#stdout.output,
      truncated: this.#stderr.truncated || this.#stdout.truncated,
    };
  }

  async inspectStatus(): Promise<{ readonly exitCode?: number }> {
    this.#throwIfFailed();
    return { exitCode: this.#exitCode };
  }

  async terminate(): Promise<void> {
    try {
      await this.#handle.kill();
    } catch (error) {
      await Promise.resolve();
      if (!this.completed) throw error;
    }
    this.#remove();
  }

  #throwIfFailed(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }
}

function validateCommandId(commandId: string): void {
  if (commandId.length === 0 || commandId.length > 256 || /\s/.test(commandId)) {
    throw new Error("Invalid sandbox command id.");
  }
}

class TailOutputBuffer {
  #discardingLine = false;
  #lineLength = 0;
  output = "";
  truncated = false;

  append(value: string): void {
    const segments = value.split("\n");
    for (const [index, segment] of segments.entries()) {
      if (!this.#discardingLine) {
        const available = MAX_LINE_LENGTH - this.#lineLength;
        const kept = segment.slice(0, Math.max(0, available));
        this.output += kept;
        this.#lineLength += kept.length;
        if (kept.length < segment.length) {
          this.output += LINE_TRUNCATION_SUFFIX;
          this.#discardingLine = true;
          this.truncated = true;
        }
      }
      if (index < segments.length - 1) {
        this.output += "\n";
        this.#discardingLine = false;
        this.#lineLength = 0;
      }
    }
    const bounded = truncateTail(this.output);
    this.output = bounded.output;
    this.truncated ||= bounded.truncated;
  }
}

async function captureOutput(
  stream: ReadableStream<Uint8Array>,
  output: TailOutputBuffer,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output.append(decoder.decode(chunk.value, { stream: true }));
  }
  output.append(decoder.decode());
}
