import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CodexAppServerClient, type CodexAppServerProcess } from "./codex-app-server.js";

describe("Codex app-server client", () => {
  it("initializes once and requests an auth token without exposing it", async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient({
      spawnProcess: vi.fn(() => child.asChildProcess()),
    });

    const status = await client.getAuthStatus({ refreshToken: true });

    expect(status).toEqual({
      authMethod: "chatgpt",
      authToken: "secret-token",
      requiresOpenaiAuth: true,
    });
    expect(child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "getAuthStatus",
    ]);
    expect(child.requests[2]?.params).toEqual({ includeToken: true, refreshToken: true });
  });

  it("reports a missing Codex binary with actionable guidance", async () => {
    const child = new FakeChild({
      failWith: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    });
    const client = new CodexAppServerClient({
      spawnProcess: vi.fn(() => child.asChildProcess()),
    });

    await expect(client.getAuthStatus({ refreshToken: false })).rejects.toThrow(
      "requires the Codex CLI",
    );
  });
});

interface RpcRequest {
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RpcRequest[] = [];
  readonly #failWith?: Error;
  #input = "";

  constructor(options: { readonly failWith?: Error } = {}) {
    super();
    this.#failWith = options.failWith;
    this.stdin.on("data", (chunk: Buffer) => this.#receive(chunk.toString()));
    queueMicrotask(() => {
      if (this.#failWith !== undefined) this.emit("error", this.#failWith);
    });
  }

  asChildProcess(): CodexAppServerProcess {
    return this;
  }

  kill(): boolean {
    return true;
  }

  unref(): void {}

  #receive(chunk: string): void {
    this.#input += chunk;
    while (true) {
      const newline = this.#input.indexOf("\n");
      if (newline < 0) return;
      const line = this.#input.slice(0, newline);
      this.#input = this.#input.slice(newline + 1);
      const request = JSON.parse(line) as RpcRequest;
      this.requests.push(request);
      if (request.id === undefined) continue;
      const result =
        request.method === "initialize"
          ? { codexHome: "/tmp/codex" }
          : {
              authMethod: "chatgpt",
              authToken: "secret-token",
              requiresOpenaiAuth: true,
            };
      this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  }
}
