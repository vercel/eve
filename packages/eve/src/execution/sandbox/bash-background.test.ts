import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "#shared/sandbox-session.js";

import {
  getBackgroundBashProcess,
  MAX_BACKGROUND_BASH_PROCESSES,
  startBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "./bash-background.js";

function sandbox(): SandboxSession {
  return {
    id: "sandbox",
    readBinaryFile: vi.fn(async () => null),
    readFile: vi.fn(async () => null),
    readTextFile: vi.fn(async () => null),
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

describe("background bash processes", () => {
  it("launches a detached command with durable status files behind the process cap", async () => {
    const session = sandbox();
    const process = await startBackgroundBashProcess(session, "pnpm test");

    expect(process.processId).toMatch(/^[0-9a-f-]{36}$/);
    const command = vi.mocked(session.run).mock.calls[0]?.[0].command;
    expect(command).toContain("( eval 'pnpm test'; code=$?");
    expect(command).toContain(`-ge ${MAX_BACKGROUND_BASH_PROCESSES}`);
  });

  it("rejects a new command when the sandbox is at the process cap", async () => {
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

  it("reads a completed process from its durable process id", async () => {
    const session = sandbox();
    vi.mocked(session.readTextFile)
      .mockResolvedValueOnce("123")
      .mockResolvedValueOnce("7")
      .mockResolvedValueOnce("out")
      .mockResolvedValueOnce("err");

    await expect(
      getBackgroundBashProcess(session, "11111111-1111-4111-8111-111111111111").read(),
    ).resolves.toEqual({ exitCode: 7, stderr: "err", stdout: "out" });
  });

  it("rejects a process id without durable process state", async () => {
    const session = sandbox();

    await expect(
      getBackgroundBashProcess(session, "11111111-1111-4111-8111-111111111111").read(),
    ).rejects.toThrow('Bash process "11111111-1111-4111-8111-111111111111" does not exist.');
  });

  it("yields without killing a process that is still running", async () => {
    const read = vi.fn(async () => ({ stderr: "", stdout: "partial" }));

    await expect(
      waitForBackgroundBashProcess({
        process: { kill: vi.fn(async () => {}), processId: "process", read },
        yieldTimeMs: 0,
      }),
    ).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });
});
