import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "#shared/sandbox-session.js";

import {
  getBackgroundBashProcess,
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
  it("launches a detached command with durable status and output files", async () => {
    const session = sandbox();
    const process = await startBackgroundBashProcess(session, "pnpm test");

    expect(process.processId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.run).toHaveBeenCalledWith({
      command: expect.stringContaining("( eval 'pnpm test'; code=$?"),
    });
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
        yieldAfterMs: 0,
      }),
    ).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });
});
