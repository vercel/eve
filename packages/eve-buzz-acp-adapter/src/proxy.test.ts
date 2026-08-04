import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runProxy } from "./proxy.js";

describe("Buzz ACP proxy lifecycle", () => {
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
      environment: {},
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
