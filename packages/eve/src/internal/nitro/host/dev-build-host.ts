// Type-only imports keep this module cheap: the dev server forks its first build
// process before it loads the compiler, Nitro, or its own server modules.
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import type { WorkspaceExtension } from "#internal/nitro/host/workspace-extensions.js";
import { toError } from "#shared/errors.js";

export interface DevelopmentPrepareInput {
  readonly appRoot: string;
  readonly changedPaths?: readonly string[];
  readonly developmentExtensions?: DevelopmentExtensionSelection;
  readonly previousExtensions?: readonly WorkspaceExtension[];
}

/** Worker entry and data for a built Nitro host. */
export interface DevelopmentHostBuild {
  readonly entry: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

interface DevelopmentBuildOperations {
  readonly buildHost: {
    readonly input: PreparedDevelopmentApplicationHost;
    readonly value: DevelopmentHostBuild;
  };
  readonly prepare: {
    readonly input: DevelopmentPrepareInput;
    readonly value: PreparedDevelopmentApplicationHost;
  };
}

export type DevelopmentBuildOperation = keyof DevelopmentBuildOperations;

// Authored code also runs in the build process and may send its own IPC messages.
export const DEVELOPMENT_BUILD_MESSAGE_KIND = "eve:development-build";

export interface DevelopmentBuildRequest {
  /** Probe result from an earlier build process, adopted before anything can probe again. */
  readonly dockerAvailability: boolean | undefined;
  /** The dev server's environment, including `.env` changes staged for this rebuild. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly id: number;
  readonly input: unknown;
  readonly kind: typeof DEVELOPMENT_BUILD_MESSAGE_KIND;
  readonly operation: DevelopmentBuildOperation;
}

export type DevelopmentBuildOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: SerializedError };

export type DevelopmentBuildResponse = {
  readonly dockerAvailability: boolean | undefined;
  readonly id: number;
  readonly kind: typeof DEVELOPMENT_BUILD_MESSAGE_KIND;
} & DevelopmentBuildOutcome;

export interface DevelopmentBuildSession {
  prepare(input: DevelopmentPrepareInput): Promise<PreparedDevelopmentApplicationHost>;
  buildHost(host: PreparedDevelopmentApplicationHost): Promise<DevelopmentHostBuild>;
  /** Ends the session. Its build process exits, releasing everything it loaded. */
  close(): void;
}

interface SerializedError {
  cause?: SerializedError;
  message: string;
  name: string;
  stack?: string;
}

const MAX_SERIALIZED_CAUSE_DEPTH = 8;

const activeProcesses = new Set<DevelopmentBuildProcess>();
let spareProcess: DevelopmentBuildProcess | undefined;
let sparesEnabled = false;
let dockerAvailability: boolean | undefined;
let nextRequestId = 0;

/**
 * Starts a build session for one rebuild. Every step that evaluates authored
 * code or runs Rolldown happens in the session's child process, which exits
 * when the session closes. Node never unloads an imported module and
 * Rolldown's native memory belongs to the whole process, so exiting is the
 * only way to release both.
 */
export function beginDevelopmentBuild(): DevelopmentBuildSession {
  // eve's own tests load this module from TypeScript source, which a child
  // process cannot import without the test runner's transform.
  if (import.meta.url.endsWith(".ts")) {
    return createInProcessSession();
  }

  sparesEnabled = true;
  const buildProcess = takeSpareProcess() ?? new DevelopmentBuildProcess();
  activeProcesses.add(buildProcess);
  let closed = false;

  return {
    prepare: async (input) => await buildProcess.request("prepare", input),
    buildHost: async (host) => await buildProcess.request("buildHost", host),
    close() {
      if (closed) return;
      closed = true;
      activeProcesses.delete(buildProcess);
      buildProcess.close();
      // The next rebuild should not wait for a process to start and load the compiler.
      if (sparesEnabled) spareProcess ??= new DevelopmentBuildProcess();
    },
  };
}

/** Forks a build process ahead of the first rebuild so its startup overlaps the dev server's. */
export function prewarmDevelopmentBuildProcess(): void {
  if (!import.meta.url.endsWith(".ts")) {
    spareProcess ??= new DevelopmentBuildProcess();
  }
}

/** Stops every build process, including the spare, so none outlives the dev server. */
export function closeDevelopmentBuildProcesses(): void {
  sparesEnabled = false;
  spareProcess?.close();
  spareProcess = undefined;
  for (const buildProcess of activeProcesses) buildProcess.close();
  activeProcesses.clear();
}

function takeSpareProcess(): DevelopmentBuildProcess | undefined {
  const spare = spareProcess;
  spareProcess = undefined;
  if (spare?.alive) return spare;
  spare?.close();
  return undefined;
}

function createInProcessSession(): DevelopmentBuildSession {
  const operations = import("#internal/nitro/host/dev-build-operations.js");
  return {
    prepare: async (input) => await (await operations).prepareDevelopmentBuild(input),
    buildHost: async (host) => await (await operations).buildDevelopmentHost(host),
    close() {},
  };
}

class DevelopmentBuildProcess {
  readonly #child: ChildProcess;
  #exitError: Error | undefined;
  readonly #pending = new Map<
    number,
    { readonly reject: (error: Error) => void; readonly resolve: (value: unknown) => void }
  >();

  constructor() {
    this.#child = fork(fileURLToPath(new URL("./dev-build-process.js", import.meta.url)), [], {
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.#child.on("message", (message: Partial<DevelopmentBuildResponse> | null) => {
      if (message?.kind !== DEVELOPMENT_BUILD_MESSAGE_KIND || message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      this.#idleWhenSettled();
      // The sandbox choice must stay stable for the dev server's lifetime.
      dockerAvailability ??= message.dockerAvailability;
      const response = message as DevelopmentBuildResponse;
      if (response.ok) pending.resolve(response.value);
      else pending.reject(deserializeError(response.error));
    });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => this.#fail(createExitError(code, signal)));
    this.#idleWhenSettled();
  }

  get alive(): boolean {
    return this.#exitError === undefined && this.#child.connected;
  }

  request<Operation extends DevelopmentBuildOperation>(
    operation: Operation,
    input: DevelopmentBuildOperations[Operation]["input"],
  ): Promise<DevelopmentBuildOperations[Operation]["value"]> {
    if (this.#exitError !== undefined) return Promise.reject(this.#exitError);

    const id = ++nextRequestId;
    const request: DevelopmentBuildRequest = {
      dockerAvailability,
      environment: { ...process.env },
      id,
      input,
      kind: DEVELOPMENT_BUILD_MESSAGE_KIND,
      operation,
    };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve: resolve as (value: unknown) => void });
      this.#child.ref();
      this.#child.channel?.ref?.();
      this.#child.send(request, (error) => {
        if (error !== null) this.#fail(error);
      });
    });
  }

  close(): void {
    if (this.#child.connected) this.#child.disconnect();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
  }

  #fail(error: Error): void {
    this.#exitError ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#exitError);
    this.#pending.clear();
  }

  // An idle build process must not keep the dev server alive. Bun's channel has no ref/unref.
  #idleWhenSettled(): void {
    if (this.#pending.size > 0) return;
    this.#child.unref();
    this.#child.channel?.unref?.();
  }
}

function createExitError(code: number | null, signal: NodeJS.Signals | null): Error {
  if (code === 0) {
    return new Error(
      "Compiling the agent stopped before it finished, because it was waiting on work that can never complete. Check authored modules for top-level awaits on promises that never settle.",
    );
  }
  if (signal === "SIGABRT" || code === 134) {
    return new Error(
      "The agent build process aborted, most likely because it ran out of memory. Reduce what authored modules import when they load, or raise the heap limit with NODE_OPTIONS=--max-old-space-size=<megabytes>.",
    );
  }
  return new Error(
    `The agent build process exited (${signal ?? `code ${String(code)}`}) before finishing.`,
  );
}

export function serializeError(error: unknown, depth = 0): SerializedError {
  const value = toError(error);
  const cause = (value as { cause?: unknown }).cause;
  const serialized: SerializedError = { message: value.message, name: value.name };

  if (value.stack !== undefined) {
    serialized.stack = value.stack;
  }

  if (cause !== undefined && depth < MAX_SERIALIZED_CAUSE_DEPTH) {
    serialized.cause = serializeError(cause, depth + 1);
  }

  return serialized;
}

function deserializeError(serialized: SerializedError): Error {
  const error = toError(serialized);

  if (serialized.cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = deserializeError(serialized.cause);
  }

  return error;
}
