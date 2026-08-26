import { randomUUID } from "node:crypto";

import type { SandboxProcess, SandboxSession } from "#shared/sandbox-session.js";
import {
  LINE_TRUNCATION_SUFFIX,
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
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

export interface ManagedSandboxCommands {
  start(input: {
    readonly command: string;
    readonly idempotencyKey: string;
  }): Promise<ManagedSandboxCommand>;
  get(commandId: string): Promise<ManagedSandboxCommand>;
}

export interface ManagedSandboxCommandBackend {
  start(command: string): Promise<ManagedSandboxCommandBackendProcess>;
  reconnect(commandId: string): Promise<ManagedSandboxCommandBackendProcess | null>;
}

export interface ManagedSandboxCommandBackendProcess {
  readonly commandId: string;
  readonly process: SandboxProcess;
}

const registeredBackends = new Map<string, ManagedSandboxCommandBackend>();
const registries = new Map<string, ManagedSandboxCommandRegistry>();

export function registerManagedSandboxCommandBackend(
  sandbox: SandboxSession,
  backend: ManagedSandboxCommandBackend,
): void {
  registeredBackends.set(sandbox.id, backend);
}

export function clearManagedSandboxCommands(sandboxId: string): void {
  registries.delete(sandboxId);
  registeredBackends.delete(sandboxId);
}

export function getManagedSandboxCommands(sandbox: SandboxSession): ManagedSandboxCommands {
  const backend = registeredBackends.get(sandbox.id) ?? createSpawnCommandBackend(sandbox);
  let registry = registries.get(sandbox.id);
  if (registry === undefined) {
    const created = new ManagedSandboxCommandRegistry(backend, () => {
      if (registries.get(sandbox.id) === created) registries.delete(sandbox.id);
    });
    registry = created;
    registries.set(sandbox.id, registry);
  } else {
    registry.setBackend(backend);
  }
  return registry;
}

function createSpawnCommandBackend(sandbox: SandboxSession): ManagedSandboxCommandBackend {
  return {
    async start(command) {
      return { commandId: randomUUID(), process: await sandbox.spawn({ command }) };
    },
    async reconnect() {
      return null;
    },
  };
}

class ManagedSandboxCommandRegistry implements ManagedSandboxCommands {
  readonly #commands = new Map<string, SpawnedSandboxCommand | null>();
  readonly #idempotencyKeys = new Map<string, string>();
  readonly #pendingStarts = new Map<string, Promise<ManagedSandboxCommand>>();
  #backend: ManagedSandboxCommandBackend;
  readonly #onEmpty: () => void;

  constructor(backend: ManagedSandboxCommandBackend, onEmpty: () => void) {
    this.#backend = backend;
    this.#onEmpty = onEmpty;
  }

  setBackend(backend: ManagedSandboxCommandBackend): void {
    this.#backend = backend;
  }

  async start(input: {
    readonly command: string;
    readonly idempotencyKey: string;
  }): Promise<ManagedSandboxCommand> {
    const existingId = this.#idempotencyKeys.get(input.idempotencyKey);
    if (existingId !== undefined) return await this.get(existingId);
    const pending = this.#pendingStarts.get(input.idempotencyKey);
    if (pending !== undefined) return await pending;

    const start = this.#start(input);
    this.#pendingStarts.set(input.idempotencyKey, start);
    try {
      return await start;
    } finally {
      if (this.#pendingStarts.get(input.idempotencyKey) === start) {
        this.#pendingStarts.delete(input.idempotencyKey);
      }
    }
  }

  async #start(input: {
    readonly command: string;
    readonly idempotencyKey: string;
  }): Promise<ManagedSandboxCommand> {
    if (this.#commands.size >= MAX_MANAGED_SANDBOX_COMMANDS) this.#pruneCompleted();
    if (this.#commands.size >= MAX_MANAGED_SANDBOX_COMMANDS) {
      throw new Error(
        `This sandbox already tracks ${MAX_MANAGED_SANDBOX_COMMANDS} running commands. Terminate or wait for existing commands before starting another.`,
      );
    }

    const reservationId = randomUUID();
    this.#commands.set(reservationId, null);
    try {
      const started = await this.#backend.start(input.command);
      this.#commands.delete(reservationId);
      this.#idempotencyKeys.set(input.idempotencyKey, started.commandId);
      return this.#track(started, input.idempotencyKey);
    } catch (error) {
      this.#commands.delete(reservationId);
      if (this.#commands.size === 0) this.#onEmpty();
      throw error;
    }
  }

  async get(commandId: string): Promise<ManagedSandboxCommand> {
    validateCommandId(commandId);
    const existing = this.#commands.get(commandId);
    if (existing !== undefined) {
      if (existing === null) {
        throw new Error(`Sandbox command "${commandId}" is still being submitted.`);
      }
      return existing;
    }

    const reconnected = await this.#backend.reconnect(commandId);
    if (reconnected === null) {
      throw new Error(
        `Sandbox command "${commandId}" is unavailable. Its completion state is unknown; do not rerun it unless you first verify that retrying is safe.`,
      );
    }
    return this.#track(reconnected);
  }

  #track(
    backendProcess: ManagedSandboxCommandBackendProcess,
    idempotencyKey?: string,
  ): SpawnedSandboxCommand {
    const command = new SpawnedSandboxCommand(
      backendProcess.commandId,
      backendProcess.process,
      () => {
        if (this.#commands.get(backendProcess.commandId) === command) {
          this.#commands.delete(backendProcess.commandId);
        }
        if (idempotencyKey !== undefined) this.#idempotencyKeys.delete(idempotencyKey);
        if (this.#commands.size === 0) this.#onEmpty();
      },
    );
    this.#commands.set(backendProcess.commandId, command);
    return command;
  }

  #pruneCompleted(): void {
    for (const [commandId, command] of this.#commands) {
      if (command?.completed !== true) continue;
      this.#commands.delete(commandId);
      for (const [idempotencyKey, trackedCommandId] of this.#idempotencyKeys) {
        if (trackedCommandId === commandId) this.#idempotencyKeys.delete(idempotencyKey);
      }
    }
  }
}

class SpawnedSandboxCommand implements ManagedSandboxCommand {
  readonly commandId: string;
  readonly #handle: SandboxProcess;
  readonly #remove: () => void;
  readonly #stderr = new TailOutputBuffer();
  readonly #stdout = new TailOutputBuffer();
  readonly #completion: Promise<void>;
  #exitCode: number | undefined;
  #failure: unknown;

  constructor(commandId: string, handle: SandboxProcess, remove: () => void) {
    this.commandId = commandId;
    this.#handle = handle;
    this.#remove = remove;
    this.#completion = Promise.all([
      handle.wait(),
      captureOutput(handle.stdout, this.#stdout),
      captureOutput(handle.stderr, this.#stderr),
    ]).then(
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
      await Promise.race([this.#completion, Promise.resolve()]);
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
  readonly #lines: string[] = [];
  #pending = "";
  #pendingTruncated = false;
  truncated = false;

  get output(): string {
    return [...this.#lines, this.#renderPending()].join("\n");
  }

  append(value: string): void {
    if (value.length === 0) return;
    const segments = value.split("\n");
    for (const [index, segment] of segments.entries()) {
      this.#appendToPending(segment);
      if (index < segments.length - 1) this.#completeLine();
    }
    this.#enforceLimits();
  }

  #appendToPending(value: string): void {
    if (this.#pendingTruncated) return;
    const available = MAX_LINE_LENGTH - this.#pending.length;
    this.#pending += value.slice(0, Math.max(0, available));
    this.#pendingTruncated = value.length > available;
  }

  #completeLine(): void {
    this.#lines.push(this.#renderPending());
    this.#pending = "";
    this.#pendingTruncated = false;
    this.#enforceLimits();
  }

  #renderPending(): string {
    return this.#pending + (this.#pendingTruncated ? LINE_TRUNCATION_SUFFIX : "");
  }

  #enforceLimits(): void {
    while (
      this.#lines.length + (this.#pending === "" ? 0 : 1) > MAX_OUTPUT_LINES ||
      Buffer.byteLength(this.output, "utf8") > MAX_OUTPUT_BYTES
    ) {
      if (this.#lines.length === 0) break;
      this.#lines.shift();
      this.truncated = true;
    }
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
