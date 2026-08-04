import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDevelopmentServer,
  DEV_SERVER_CLOSE_BUDGET_MS,
} from "#cli/dev/local-server-process.js";
import { FORCED_EXIT_BACKSTOP_MS } from "#cli/shutdown.js";

const mocks = vi.hoisted(() => ({ fork: vi.fn(), loadEnv: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: mocks.fork }));
vi.mock("#cli/dev/environment.js", () => ({ loadDevelopmentEnvironmentFiles: mocks.loadEnv }));

class FakeChild extends EventEmitter {
  connected = true;
  pid: number | undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly send = vi.fn();
  readonly kill = vi.fn();
  readonly disconnect = vi.fn(() => {
    this.connected = false;
  });
  readonly unref = vi.fn();
}

describe("createDevelopmentServer", () => {
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    mocks.fork.mockReturnValue(child);
  });

  it("finishes the close escalation inside the CLI forced-exit backstop", () => {
    expect(DEV_SERVER_CLOSE_BUDGET_MS).toBeLessThan(FORCED_EXIT_BACKSTOP_MS);
  });

  it("starts and hands cleanup to the child", async () => {
    const server = createDevelopmentServer("/tmp/app", { port: 2000 });
    const started = server.start();
    child.emit("message", {
      type: "started",
      handle: { kind: "started", appRoot: "/tmp/app", url: "http://127.0.0.1:2000" },
    });
    await started;

    const closing = server.close();
    expect(child.send).toHaveBeenCalledWith({ type: "shutdown" });
    child.emit("exit", 0, null);

    await closing;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("can route child stdout to stderr for protocol-owning parents", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const server = createDevelopmentServer("/tmp/app", { output: "stderr" });
      const started = server.start();
      child.stdout.write("server output");
      child.emit("message", {
        type: "started",
        handle: { kind: "started", appRoot: "/tmp/app", url: "http://127.0.0.1:2000" },
      });
      await started;

      expect(stderr).toHaveBeenCalledWith(expect.any(Buffer));
      expect(stdout).not.toHaveBeenCalled();

      const closing = server.close();
      child.emit("exit", 0, null);
      await closing;
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("escalates when graceful cleanup misses the deadline", async () => {
    vi.useFakeTimers();
    try {
      const server = createDevelopmentServer("/tmp/app");
      const started = server.start();
      child.emit("message", {
        type: "started",
        handle: { kind: "started", appRoot: "/tmp/app", url: "http://127.0.0.1:2000" },
      });
      await started;

      const closing = server.close();
      await vi.advanceTimersByTimeAsync(550);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(150);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("exit", null, "SIGKILL");

      await closing;
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates surviving descendants after the server child exits", async () => {
    vi.useFakeTimers();
    child.pid = 4321;
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-4321);
      if (signal === "SIGTERM") groupAlive = false;
      if (signal === 0 && !groupAlive) throw new Error("process group exited");
      return true;
    });
    try {
      const server = createDevelopmentServer("/tmp/app");
      const started = server.start();
      child.emit("message", {
        type: "started",
        handle: { kind: "started", appRoot: "/tmp/app", url: "http://127.0.0.1:2000" },
      });
      await started;

      const closing = server.close();
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(550);
      await closing;

      expect(kill).toHaveBeenCalledWith(-4321, "SIGTERM");
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });
});
