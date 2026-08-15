import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runProxy } from "./proxy.js";

describe("Buzz ACP proxy lifecycle", () => {
  it("rejects a shared author gate before spawning eve", async () => {
    const spawnProcess = vi.fn();

    await expect(
      runProxy({
        buzzCli: "buzz",
        cwd: "/workspace",
        environment: { BUZZ_ACP_RESPOND_TO: "anyone" },
        eveBin: "/eve",
        input: new PassThrough(),
        output: new PassThrough(),
        publicationStateDirectory: "/unused",
        publishTimeoutMs: 1_000,
        spawnProcess,
      }),
    ).rejects.toThrow("--allow-shared-principal");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("uses the installed local application root for new sessions", async () => {
    const input = new PassThrough();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const forwarded: string[] = [];
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      stdin,
      stdout,
      kill: vi.fn(() => true),
    });
    const spawnProcess: NonNullable<Parameters<typeof runProxy>[0]["spawnProcess"]> = () => child;

    const result = runProxy({
      buzzCli: "buzz",
      cwd: "/eve-app",
      environment: { BUZZ_ACP_RESPOND_TO: "owner-only" },
      eveBin: "/eve",
      input,
      output: new PassThrough(),
      publicationStateDirectory: "/unused",
      publishTimeoutMs: 1_000,
      spawnProcess,
    });
    input.end(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: "/buzz-working-directory", mcpServers: [] },
      })}\n`,
    );

    await vi.waitFor(() => expect(forwarded).toHaveLength(1));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    stdout.end();

    await expect(result).resolves.toBeUndefined();
    expect(JSON.parse(forwarded.join(""))).toMatchObject({
      method: "session/new",
      params: { cwd: "/eve-app", mcpServers: [] },
    });
  });

  it("closes and settles its input reader when eve exits first", async () => {
    const input = new PassThrough();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      stdin,
      stdout,
      kill: vi.fn(() => true),
    });
    const spawnProcess: NonNullable<Parameters<typeof runProxy>[0]["spawnProcess"]> = () => child;

    const result = runProxy({
      buzzCli: "buzz",
      cwd: "/workspace",
      environment: { BUZZ_ACP_RESPOND_TO: "owner-only" },
      eveBin: "/eve",
      input,
      output: new PassThrough(),
      publicationStateDirectory: "/unused",
      publishTimeoutMs: 1_000,
      spawnProcess,
    });
    queueMicrotask(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
      stdout.end();
    });

    await expect(result).rejects.toThrow("eve acp exited with status 1");
    expect(input.listenerCount("data")).toBe(0);
  });
});
