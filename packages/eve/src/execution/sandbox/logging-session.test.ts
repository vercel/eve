import { describe, expect, it, vi } from "vitest";

import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { MAX_OUTPUT_LINES } from "#execution/sandbox/truncate-output.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

describe("createLoggingSandboxSession", () => {
  it("logs bootstrap commands and file operations without logging contents", async () => {
    const log = vi.fn();
    const session = createTestSession();
    const wrapped = createLoggingSandboxSession({ log, session });

    await wrapped.run({ command: "echo secret-value" });
    await wrapped.writeTextFile({ content: "do-not-log", path: "/workspace/config.txt" });
    await wrapped.writeBinaryFile({ content: new Uint8Array([1, 2, 3]), path: "asset.bin" });
    await wrapped.removePath({ path: "old.txt" });

    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "bootstrap run: echo secret-value",
      "bootstrap write text file: /workspace/config.txt (10 chars)",
      "bootstrap write binary file: asset.bin (3 bytes)",
      "bootstrap remove path: old.txt",
    ]);
    expect(log.mock.calls.flat().join("\n")).not.toContain("do-not-log");
  });

  it("wraps the original session when no logger is provided", () => {
    const session = createTestSession();
    expect(createLoggingSandboxSession({ session })).not.toBe(session);
  });

  it("fails bootstrap when a run command exits with code 1", async () => {
    const session = createTestSession({
      exitCode: 1,
      stderr: "install failed\nmissing package\n",
      stdout: "installing package\n",
    });
    const wrapped = createLoggingSandboxSession({ session });

    await expect(wrapped.run({ command: "pnpm install --frozen-lockfile" })).rejects.toThrow(
      [
        "Sandbox bootstrap failed because sandbox.run command exited with code 1:",
        "pnpm install --frozen-lockfile",
        "",
        "stdout:",
        "installing package\n",
        "",
        "stderr:",
        "install failed\nmissing package\n",
      ].join("\n"),
    );
  });

  it("truncates bootstrap failure stdout and stderr", async () => {
    const stdout = Array.from({ length: MAX_OUTPUT_LINES + 2 }, (_, i) => `stdout ${i + 1}`).join(
      "\n",
    );
    const stderr = Array.from({ length: MAX_OUTPUT_LINES + 3 }, (_, i) => `stderr ${i + 1}`).join(
      "\n",
    );
    const session = createTestSession({
      exitCode: 1,
      stderr,
      stdout,
    });
    const wrapped = createLoggingSandboxSession({ session });

    let message = "";
    try {
      await wrapped.run({ command: "python -m pip install packages" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      `[stdout truncated: showing last ${MAX_OUTPUT_LINES} of ${MAX_OUTPUT_LINES + 2} lines]`,
    );
    expect(message).toContain("stdout 3");
    expect(message).toContain(`stdout ${MAX_OUTPUT_LINES + 2}`);
    expect(message).not.toContain("stdout 1\n");
    expect(message).toContain(
      `[stderr truncated: showing last ${MAX_OUTPUT_LINES} of ${MAX_OUTPUT_LINES + 3} lines]`,
    );
    expect(message).toContain("stderr 4");
    expect(message).toContain(`stderr ${MAX_OUTPUT_LINES + 3}`);
    expect(message).not.toContain("stderr 1\n");
  });
});

function createTestSession(runResult = { exitCode: 0, stderr: "", stdout: "" }): SandboxSession {
  return {
    id: "test-session",
    resolvePath: (path) => (path.startsWith("/") ? path : `/workspace/${path}`),
    run: vi.fn(async () => runResult),
    spawn: vi.fn(async () => ({
      kill: async () => {},
      stderr: new ReadableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      wait: async () => ({ exitCode: 0 }),
    })),
    readFile: vi.fn(async () => null),
    readBinaryFile: vi.fn(async () => null),
    readTextFile: vi.fn(async () => null),
    writeFile: vi.fn(async () => {}),
    writeBinaryFile: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
    removePath: vi.fn(async () => {}),
    setNetworkPolicy: vi.fn(async () => {}),
  };
}
