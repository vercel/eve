import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxCommandResult, SandboxSession } from "#shared/sandbox-session.js";

import { executeBashOnSandbox } from "./bash.js";
import { bufferToStream } from "./stream-utils.js";
import { MAX_OUTPUT_BYTES, truncateTail } from "./truncate-output.js";

describe("executeBashOnSandbox", () => {
  const previousDevFlag = process.env[EVE_DEV_ENV_FLAG];

  afterEach(() => {
    if (previousDevFlag === undefined) {
      delete process.env[EVE_DEV_ENV_FLAG];
    } else {
      process.env[EVE_DEV_ENV_FLAG] = previousDevFlag;
    }
    vi.restoreAllMocks();
  });

  it("logs sandbox command progress in dev without adding to stderr", async () => {
    process.env[EVE_DEV_ENV_FLAG] = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sandbox = createTestSandboxSession({
      exitCode: 0,
      stderr: "",
      stdout: "weather-codes.md\n",
    });

    const result = await executeBashOnSandbox(sandbox, { command: "ls -la /workspace" });

    expect(result).toEqual({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "weather-codes.md\n",
      truncated: false,
    });
    expect(log).toHaveBeenCalledWith("eve: starting sandbox command: ls -la /workspace");
    expect(log).toHaveBeenCalledWith("eve: sandbox command finished (exit 0): ls -la /workspace");
  });

  it.each([
    [
      "short lines before one long line",
      'EXACT-ID-74\nfunction recover() {\n  return "window-1";\n}\n' + "x".repeat(96_000),
    ],
    ["more lines than are kept", Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`).join("")],
    [
      "multibyte long lines past the byte budget",
      `${"é".repeat(2500)}\n${"日本".repeat(1500)}\n`.repeat(20),
    ],
    ["a few lines", "one\ntwo\nthree"],
    ["no output", ""],
  ])("returns what truncateTail keeps from the whole output: %s", async (_name, output) => {
    const bytes = new TextEncoder().encode(output);
    let offset = 0;
    const sandbox: SandboxSession = {
      ...createTestSandboxSession({ exitCode: 0, stderr: "", stdout: "" }),
      spawn: async () => ({
        kill: async () => {},
        stderr: bufferToStream(new Uint8Array()),
        stdout: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.byteLength) return controller.close();
            controller.enqueue(bytes.subarray(offset, (offset += 7)));
          },
        }),
        wait: async () => ({ exitCode: 0 }),
      }),
    };

    const result = await executeBashOnSandbox(sandbox, { command: "build" });

    const expected = truncateTail(output);
    expect(result).toMatchObject({ stderr: "", truncated: expected.truncated });
    expect(result.stdout).toBe(
      expected.truncated
        ? `[stdout truncated: showing last ${expected.outputLines} of ${expected.totalLines} lines]\n${expected.output}`
        : expected.output,
    );
  });

  it(
    "returns the tail of output too large to hold as one string",
    { timeout: 30_000 },
    async () => {
      const line = `${"x".repeat(1023)}\n`;
      const chunk = new TextEncoder().encode(line.repeat(1024));
      let chunks = 2 ** 29 / chunk.byteLength + 1;
      const stdout = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks-- > 0) controller.enqueue(chunk);
          else controller.close();
        },
      });
      const sandbox: SandboxSession = {
        ...createTestSandboxSession({ exitCode: 0, stderr: "", stdout: "" }),
        spawn: async () => ({
          kill: async () => {},
          stderr: bufferToStream(new Uint8Array()),
          stdout,
          wait: async () => ({ exitCode: 0 }),
        }),
      };

      const result = await executeBashOnSandbox(sandbox, { command: "cat build.log" });

      expect(result).toMatchObject({
        exitCode: 0,
        status: "completed",
        stderr: "",
        truncated: true,
      });
      expect(result.stdout.endsWith(line)).toBe(true);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(2 * MAX_OUTPUT_BYTES);
    },
  );

  it("reads inline job metadata from stderr without calling sandbox.run on truncated output", async () => {
    const encoder = new TextEncoder();
    const run = vi.fn(async () => {
      throw new Error("sandbox.run should not be called");
    });
    const sandbox: SandboxSession = {
      ...createTestSandboxSession({ exitCode: 0, stderr: "", stdout: "" }),
      run,
      spawn: async ({ command }) => {
        const jobId = /set -- '\/tmp\/\.eve\/jobs\/([0-9a-f]+)'/u.exec(command)?.[1];
        if (jobId === undefined) throw new Error(`missing jobId in command: ${command}`);
        const longStderr = `${"e".repeat(2500)}\0__eve_job__:${jobId}:12000:1\0`;
        const stderrBytes = encoder.encode(longStderr);
        let offset = 0;
        return {
          kill: async () => {},
          stderr: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= stderrBytes.byteLength) return controller.close();
              controller.enqueue(stderrBytes.subarray(offset, (offset += 11)));
            },
          }),
          stdout: bufferToStream(
            encoder.encode(Array.from({ length: 2100 }, (_, i) => `line ${i}\n`).join("")),
          ),
          wait: async () => ({ exitCode: 0 }),
        };
      },
    };

    const result = await executeBashOnSandbox(sandbox, { command: "build" });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 0, status: "completed", truncated: true });
    expect(result.stdout).toMatch(
      /^\[stdout truncated: showing last 2000 of 12000 lines; full output: \/tmp\/\.eve\/jobs\/[0-9a-f]+\/stdout\]\n/u,
    );
    expect(result.stderr).toMatch(
      /^\[stderr truncated: line exceeded 2000 chars; full output: \/tmp\/\.eve\/jobs\/[0-9a-f]+\/stderr\]\n/u,
    );
    expect(result.stderr).not.toContain("__eve_job__");
  });

  it("returns a timeout result instead of throwing AbortError when fallback spawn rejects on signal", async () => {
    vi.useFakeTimers();
    try {
      const sandbox: SandboxSession = {
        ...createTestSandboxSession({ exitCode: 0, stderr: "", stdout: "" }),
        run: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
        spawn: async ({ signal }) => ({
          kill: async () => {},
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          }),
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          }),
          wait: () =>
            new Promise<{ exitCode: number }>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            }),
        }),
      };

      const pending = executeBashOnSandbox(sandbox, { command: "sleep 30", timeout: 1 });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toEqual({
        exitCode: 124,
        status: "completed",
        stderr: "Command timed out after 1 seconds.\n",
        stdout: "",
        truncated: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createTestSandboxSession(result: SandboxCommandResult): SandboxSession {
  const encoder = new TextEncoder();
  return {
    readBinaryFile: async () => null,
    readFile: async () => null,
    readTextFile: async () => null,
    removePath: async () => {},
    resolvePath: (path) => path,
    run: async () => {
      throw new Error("run is not used by a command that finishes in time");
    },
    spawn: async () => ({
      kill: async () => {},
      stderr: bufferToStream(encoder.encode(result.stderr)),
      stdout: bufferToStream(encoder.encode(result.stdout)),
      wait: async () => ({ exitCode: result.exitCode }),
    }),
    writeBinaryFile: async () => {},
    writeFiles: async () => {},
    writeFile: async () => {},
    writeTextFile: async () => {},
  };
}
