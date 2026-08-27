import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { isObject } from "#shared/guards.js";

interface RpcError {
  readonly code?: number;
  readonly message?: string;
}

interface RpcResponse {
  readonly error?: RpcError;
  readonly id?: number;
  readonly result?: unknown;
}

export interface CodexAuthStatus {
  readonly authMethod?: string;
  readonly authToken?: string;
  readonly requiresOpenaiAuth?: boolean;
}

export interface CodexAppServer {
  getAuthStatus(input: { readonly refreshToken: boolean }): Promise<CodexAuthStatus>;
  restart?(): void;
}

export interface CodexAppServerProcess {
  readonly stderr: ChildProcessWithoutNullStreams["stderr"];
  readonly stdin: ChildProcessWithoutNullStreams["stdin"];
  readonly stdout: ChildProcessWithoutNullStreams["stdout"];
  kill(): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  unref(): void;
}

type SpawnCodexAppServer = (
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => CodexAppServerProcess;

export interface CodexAppServerOptions {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnCodexAppServer;
}

/** Minimal authenticated subset of Codex's JSONL app-server protocol. */
export class CodexAppServerClient implements CodexAppServer {
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #spawnProcess: SpawnCodexAppServer;
  #connection: Promise<CodexAppServerConnection> | undefined;

  constructor(options: CodexAppServerOptions = {}) {
    this.#command = options.command ?? "codex";
    this.#env = options.env;
    this.#spawnProcess = options.spawnProcess ?? spawnCodexAppServer;
  }

  async getAuthStatus(input: { readonly refreshToken: boolean }): Promise<CodexAuthStatus> {
    const connection = await this.#connect();
    try {
      return await connection.getAuthStatus(input);
    } catch (error) {
      if (connection.exited) this.#connection = undefined;
      throw error;
    }
  }

  restart(): void {
    const connection = this.#connection;
    this.#connection = undefined;
    void connection?.then((value) => value.close()).catch(() => undefined);
  }

  #connect(): Promise<CodexAppServerConnection> {
    if (this.#connection === undefined) {
      this.#connection = CodexAppServerConnection.start({
        command: this.#command,
        env: this.#env,
        spawnProcess: this.#spawnProcess,
      }).catch((error: unknown) => {
        this.#connection = undefined;
        throw error;
      });
    }
    return this.#connection;
  }
}

class CodexAppServerConnection {
  readonly #child: CodexAppServerProcess;
  readonly #lines: Interface;
  readonly #pending = new Map<
    number,
    { readonly reject: (error: Error) => void; readonly resolve: (value: unknown) => void }
  >();
  #nextId = 1;
  #exited = false;
  #failure: Error | undefined;

  private constructor(child: CodexAppServerProcess) {
    this.#child = child;
    // The broker must not keep the agent runtime alive during normal shutdown.
    child.unref();
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    child.stderr.resume();
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => this.#handleLine(line));
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => {
      const suffix = signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
      this.#fail(new Error(`Codex app-server exited with ${suffix}.`));
    });
  }

  get exited(): boolean {
    return this.#exited;
  }

  close(): void {
    this.#child.kill();
    this.#fail(new Error("Codex app-server connection was restarted."));
  }

  static async start(input: {
    readonly command: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly spawnProcess: SpawnCodexAppServer;
  }): Promise<CodexAppServerConnection> {
    let child: CodexAppServerProcess;
    try {
      child = input.spawnProcess(input.command, ["app-server", "--stdio"], {
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw codexUnavailableError(error);
    }

    const connection = new CodexAppServerConnection(child);
    try {
      await connection.#request("initialize", {
        capabilities: null,
        clientInfo: { name: "eve", title: "eve", version: "0.35.0" },
      });
      connection.#notify("initialized", {});
      return connection;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async getAuthStatus(input: { readonly refreshToken: boolean }): Promise<CodexAuthStatus> {
    const value = await this.#request("getAuthStatus", {
      includeToken: true,
      refreshToken: input.refreshToken,
    });
    if (!isObject(value)) {
      throw new Error("Codex app-server returned an invalid authentication response.");
    }
    return {
      ...(typeof value.authMethod === "string" && { authMethod: value.authMethod }),
      ...(typeof value.authToken === "string" && { authToken: value.authToken }),
      ...(typeof value.requiresOpenaiAuth === "boolean" && {
        requiresOpenaiAuth: value.requiresOpenaiAuth,
      }),
    };
  }

  #request(method: string, params: unknown): Promise<unknown> {
    if (this.#exited) {
      return Promise.reject(this.#failure ?? new Error("Codex app-server is not running."));
    }
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    this.#write({ id, method, params });
    return response;
  }

  #notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  #write(value: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #handleLine(line: string): void {
    let value: RpcResponse;
    try {
      value = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    this.#pending.delete(value.id);
    if (value.error !== undefined) {
      pending.reject(
        new Error(value.error.message ?? `Codex app-server request failed (${value.error.code}).`),
      );
      return;
    }
    pending.resolve(value.result);
  }

  #fail(error: Error): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#failure = codexUnavailableError(error);
    this.#lines.close();
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }
}

function spawnCodexAppServer(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
): CodexAppServerProcess {
  return spawn(command, [...args], options);
}

function unrefStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  if ("unref" in stream && typeof stream.unref === "function") stream.unref();
}

function codexUnavailableError(error: unknown): Error {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return new Error(
      "ChatGPT subscription authentication requires the Codex CLI. Install or upgrade `codex`, then run `codex login`.",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Codex app-server is unavailable: ${message}`);
}
