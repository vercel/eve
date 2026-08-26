import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "#shared/sandbox-session.js";

import {
  DEFAULT_BASH_YIELD_TIME_MS,
  executeBashOnSandbox,
  getBackgroundBashProcess,
  MAX_BACKGROUND_BASH_PROCESSES,
  startBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "./bash.js";

function sandbox(files: Record<string, string | null> = {}): SandboxSession {
  return {
    id: "sandbox",
    readBinaryFile: vi.fn(async () => null),
    readFile: vi.fn(async () => null),
    readTextFile: vi.fn(async ({ path }) => files[path] ?? null),
    removePath: vi.fn(async () => {}),
    resolvePath: (path) => path,
    run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    setNetworkPolicy: vi.fn(async () => {}),
    spawn: vi.fn(async () => {
      throw new Error("not used");
    }),
    writeBinaryFile: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
  };
}

function processFiles(values: { exitCode?: number; stderr?: string; stdout?: string }) {
  return new Proxy<Record<string, string | null>>(
    {},
    {
      get: (_target, path) => {
        if (typeof path !== "string") return null;
        if (path.endsWith("/pid")) return "123";
        if (path.endsWith("/exit-code")) return values.exitCode?.toString() ?? null;
        if (path.endsWith("/stderr")) return values.stderr ?? "";
        if (path.endsWith("/stdout")) return values.stdout ?? "";
        return null;
      },
    },
  );
}

describe("executeBashOnSandbox", () => {
  it("returns completed output", async () => {
    const session = sandbox(processFiles({ exitCode: 0, stdout: "done\n" }));

    await expect(executeBashOnSandbox(session, { command: "build" })).resolves.toEqual({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "done\n",
      truncated: false,
      wallTimeSeconds: expect.any(Number),
    });
  });

  it("yields a running command", async () => {
    const session = sandbox(processFiles({ stderr: "partial err", stdout: "partial out" }));

    await expect(
      executeBashOnSandbox(session, { command: "build", yieldTimeMs: 0 }),
    ).resolves.toMatchObject({
      status: "running",
      stderr: "partial err",
      stdout: "partial out",
    });
  });

  it("does not kill after an observation failure", async () => {
    const session = sandbox();
    vi.mocked(session.readTextFile).mockRejectedValue(new Error("read failed"));

    await expect(executeBashOnSandbox(session, { command: "build" })).rejects.toThrow(
      "read failed",
    );
    expect(session.run).toHaveBeenCalledOnce();
  });

  it("kills when cancelled", async () => {
    const session = sandbox(processFiles({}));
    const cancelled = new DOMException("cancelled", "AbortError");

    await expect(
      executeBashOnSandbox(
        session,
        { command: "build" },
        { abortSignal: AbortSignal.abort(cancelled) },
      ),
    ).rejects.toBe(cancelled);
    expect(session.removePath).toHaveBeenCalledWith({
      force: true,
      path: expect.stringContaining("/.eve/processes/"),
      recursive: true,
    });
  });

  it("uses the default foreground wait", () => {
    expect(DEFAULT_BASH_YIELD_TIME_MS).toBe(300_000);
  });
});

describe("background bash processes", () => {
  it("launches an isolated command behind the process cap", async () => {
    const session = sandbox();
    const process = await startBackgroundBashProcess(session, "exit 7");
    const command = vi.mocked(session.run).mock.calls[0]?.[0].command;

    expect(process.processId).toMatch(/^[0-9a-f-]{36}$/);
    expect(command).toContain("set -m 2>/dev/null || true");
    expect(command).toContain(`-ge ${MAX_BACKGROUND_BASH_PROCESSES}`);
    expect(command).toContain("( ( eval 'exit 7' ); code=$?");
  });

  it("rejects when the process cap is reached", async () => {
    const session = sandbox();
    vi.mocked(session.run).mockResolvedValue({
      exitCode: 75,
      stderr: "EVE_BASH_PROCESS_LIMIT\n",
      stdout: "",
    });

    await expect(startBackgroundBashProcess(session, "pnpm test")).rejects.toThrow(
      `This sandbox already tracks ${MAX_BACKGROUND_BASH_PROCESSES} running background commands.`,
    );
  });

  it("reads completed process state", async () => {
    const session = sandbox(processFiles({ exitCode: 7, stderr: "err", stdout: "out" }));

    await expect(
      getBackgroundBashProcess(session, "11111111-1111-4111-8111-111111111111").read(),
    ).resolves.toEqual({ exitCode: 7, stderr: "err", stdout: "out" });
  });

  it("removes process state even when the process already exited", async () => {
    const session = sandbox(processFiles({}));
    vi.mocked(session.run).mockResolvedValue({ exitCode: 1, stderr: "", stdout: "" });

    await getBackgroundBashProcess(session, "11111111-1111-4111-8111-111111111111").kill();

    expect(session.removePath).toHaveBeenCalledWith({
      force: true,
      path: "/workspace/.eve/processes/11111111-1111-4111-8111-111111111111",
      recursive: true,
    });
  });

  it("rejects missing process state", async () => {
    const session = sandbox();

    await expect(
      getBackgroundBashProcess(session, "11111111-1111-4111-8111-111111111111").read(),
    ).rejects.toThrow("does not exist");
  });

  it("polls status without reading output", async () => {
    const read = vi.fn();
    const readStatus = vi.fn(async () => ({}));

    await expect(
      waitForBackgroundBashProcess({
        process: { kill: vi.fn(), processId: "process", read, readStatus },
        yieldTimeMs: 0,
      }),
    ).resolves.toBeNull();
    expect(readStatus).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
});
