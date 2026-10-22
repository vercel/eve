// Type-only imports keep this module cheap: the dev server forks its first build
// process before it loads the compiler, Nitro, or its own server modules.
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import { LINUX_DOCKER_AVAILABILITY_ENV } from "#execution/sandbox/bindings/docker-cli.js";
import {
  createDevelopmentHostWorkspace,
  type DevelopmentHostWorkspace,
  removeDevelopmentHostWorkspace,
} from "#internal/nitro/host/dev-host-workspace.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import type { WorkspaceExtension } from "#internal/nitro/host/workspace-extensions.js";
import { toError } from "#shared/errors.js";

export interface DevelopmentPrepareInput {
  readonly appRoot: string;
  readonly changedPaths?: readonly string[];
  readonly developmentExtensions?: DevelopmentExtensionSelection;
  readonly previousExtensions?: readonly WorkspaceExtension[];
  /** Created by the dev server, so it can remove the workspace if the build process dies. */
  readonly workspace?: DevelopmentHostWorkspace;
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
  /** The build's Docker probe result, if it probed. */
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

/** The build processes owned by one dev server. */
export interface DevelopmentBuilds {
  /**
   * Starts a build session for one rebuild. Every step that evaluates
   * authored code or runs Rolldown happens in the session's child process,
   * which exits when the session closes. Node never unloads an imported
   * module and Rolldown's native memory belongs to the whole process, so
   * exiting is the only way to release both.
   */
  begin(): DevelopmentBuildSession;
  /** Stops every build process, including the spare. Later sessions fail. */
  close(): void;
}

interface SerializedError {
  cause?: SerializedError;
  message: string;
  name: string;
  stack?: string;
}

const MAX_SERIALIZED_CAUSE_DEPTH = 8;

let prewarmedProcess: DevelopmentBuildProcess | undefined;
let nextRequestId = 0;

/**
 * Forks a build process before the dev server loads its own modules, so the
 * two startups overlap. The first {@link createDevelopmentBuilds} adopts it.
 */
export function prewarmDevelopmentBuildProcess(): void {
  if (!isSourceCheckout()) {
    prewarmedProcess ??= new DevelopmentBuildProcess();
  }
}

export function createDevelopmentBuilds(): DevelopmentBuilds {
  if (isSourceCheckout()) {
    return { begin: createInProcessSession, close() {} };
  }

  let spare = prewarmedProcess;
  prewarmedProcess = undefined;
  const active = new Set<DevelopmentBuildProcess>();
  let closed = false;

  return {
    begin() {
      if (closed) {
        throw new Error("The dev server is closed, so it cannot start another build.");
      }
      const buildProcess = spare?.alive === true ? spare : new DevelopmentBuildProcess();
      if (spare !== buildProcess) spare?.close();
      spare = undefined;
      active.add(buildProcess);
      let ended = false;

      return {
        async prepare(input) {
          const workspace = await createDevelopmentHostWorkspace(input.appRoot);
          try {
            return await buildProcess.request("prepare", { ...input, workspace });
          } catch (error) {
            await removeDevelopmentHostWorkspace(workspace).catch(() => undefined);
            throw error;
          }
        },
        buildHost: async (host) => await buildProcess.request("buildHost", host),
        close() {
          if (ended) return;
          ended = true;
          active.delete(buildProcess);
          buildProcess.close();
          // The next rebuild should not wait for a process to start and load the compiler.
          if (!closed) spare ??= new DevelopmentBuildProcess();
        },
      };
    },
    close() {
      closed = true;
      spare?.close();
      spare = undefined;
      for (const buildProcess of active) buildProcess.close();
      active.clear();
    },
  };
}

// Running from TypeScript source (eve's own tests, or a source checkout): a
// child process cannot import the source without the caller's transform.
function isSourceCheckout(): boolean {
  return import.meta.url.endsWith(".ts");
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
      publishDockerAvailability(message.dockerAvailability);
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

// Later build processes receive it with their environment, and runtime workers
// copy it when they start, so neither probes Docker again.
function publishDockerAvailability(available: boolean | undefined): void {
  if (available !== undefined && process.env[LINUX_DOCKER_AVAILABILITY_ENV] === undefined) {
    process.env[LINUX_DOCKER_AVAILABILITY_ENV] = available ? "1" : "0";
  }
}

function createExitError(code: number | null, signal: NodeJS.Signals | null): Error {
  if (code === 0) {
    return new Error(
      "The agent build stopped before it finished: its process ran out of work to do. This usually means an authored module awaits a promise that never settles at the top level, or calls process.exit().",
    );
  }
  if (signal === "SIGABRT" || code === 134) {
    return new Error(
      "The agent build process aborted, most likely because it ran out of memory. Reduce what authored modules import when they load, or raise the heap limit by starting eve dev with NODE_OPTIONS=--max-old-space-size=<megabytes>.",
    );
  }
  if (signal === "SIGKILL") {
    return new Error(
      "The agent build process was killed before it finished. If the system ran low on memory, reduce what authored modules import when they load.",
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
