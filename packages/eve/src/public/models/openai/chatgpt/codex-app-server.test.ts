import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ChatGptSignInRequiredError } from "./oauth.js";
import { ChatGptSignedOutError } from "./token.js";
import {
  CodexAppServerClient,
  CodexBinaryNotFoundError,
  type CodexAppServerProcess,
  type CodexAuthStatus,
} from "./codex-app-server.js";

const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("Codex app-server client", () => {
  it("initializes once and resolves an app-server token", async () => {
    const token = jwt({
      exp: NOW / 1000 + 3600,
      chatgpt_account_id: "acct-1",
      email: "alice@example.com",
    });
    const child = new FakeChild({
      statuses: [{ authMethod: "chatgpt", authToken: token, requiresOpenaiAuth: true }],
    });
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const client = new CodexAppServerClient({ spawnProcess });

    await expect(client.resolveToken({ forceRefresh: true, now: () => NOW })).resolves.toEqual({
      token,
      expiresAt: NOW + 3600_000,
      accountId: "acct-1",
      accountLabel: "alice@example.com",
    });
    expect(spawnProcess).toHaveBeenCalledWith("codex", ["app-server", "--stdio"], {
      env: undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "getAuthStatus",
    ]);
    expect(child.requests[2]?.params).toEqual({ includeToken: true, refreshToken: true });
  });

  it("refreshes an app-server token within five minutes of expiry", async () => {
    const expiring = jwt({ exp: NOW / 1000 + 60 });
    const refreshed = jwt({ exp: NOW / 1000 + 3600 });
    const child = new FakeChild({
      statuses: [
        { authMethod: "chatgpt", authToken: expiring },
        { authMethod: "chatgpt", authToken: refreshed },
      ],
    });
    const client = new CodexAppServerClient({
      spawnProcess: vi.fn(() => child.asChildProcess()),
    });

    await expect(
      client.resolveToken({ forceRefresh: false, now: () => NOW }),
    ).resolves.toMatchObject({ token: refreshed, expiresAt: NOW + 3600_000 });
    expect(child.requests.filter((request) => request.method === "getAuthStatus")).toEqual([
      expect.objectContaining({ params: { includeToken: true, refreshToken: false } }),
      expect.objectContaining({ params: { includeToken: true, refreshToken: true } }),
    ]);
  });

  it("distinguishes signed-out and rejected-token states", async () => {
    const ordinary = new CodexAppServerClient({
      spawnProcess: vi.fn(() => new FakeChild().asChildProcess()),
    });
    await expect(
      ordinary.resolveToken({ forceRefresh: false, now: () => NOW }),
    ).rejects.toBeInstanceOf(ChatGptSignedOutError);

    const rejected = new CodexAppServerClient({
      spawnProcess: vi.fn(() => new FakeChild().asChildProcess()),
    });
    await expect(
      rejected.resolveToken({ forceRefresh: true, now: () => NOW }),
    ).rejects.toBeInstanceOf(ChatGptSignInRequiredError);
  });

  it("marks only a missing Codex binary as eligible for fallback", async () => {
    const child = new FakeChild({
      failWith: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    });
    const client = new CodexAppServerClient({
      spawnProcess: vi.fn(() => child.asChildProcess()),
    });

    await expect(
      client.resolveToken({ forceRefresh: false, now: () => NOW }),
    ).rejects.toBeInstanceOf(CodexBinaryNotFoundError);
  });

  it("preserves other app-server failures as hard errors", async () => {
    const child = new FakeChild({ failWith: new Error("permission denied") });
    const client = new CodexAppServerClient({
      spawnProcess: vi.fn(() => child.asChildProcess()),
    });

    const result = client.resolveToken({ forceRefresh: false, now: () => NOW });
    await expect(result).rejects.toThrow("Codex app-server is unavailable: permission denied");
    await expect(result).rejects.not.toBeInstanceOf(CodexBinaryNotFoundError);
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
  readonly #statuses: CodexAuthStatus[];
  #input = "";

  constructor(
    options: {
      readonly failWith?: Error;
      readonly statuses?: readonly CodexAuthStatus[];
    } = {},
  ) {
    super();
    this.#failWith = options.failWith;
    this.#statuses = [...(options.statuses ?? [])];
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
          : (this.#statuses.shift() ?? { authMethod: "chatgpt" });
      this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  }
}
