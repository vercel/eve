import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxCommandResult, SandboxSession } from "#shared/sandbox-session.js";

import { executeBashOnSandbox } from "./bash.js";
import { bufferToStream } from "./stream-utils.js";
import { MAX_OUTPUT_BYTES } from "./truncate-output.js";

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

  it.fails(
    "returns the tail of output too large to hold as one string",
    { timeout: 30_000 },
    async () => {
      const line = `${"x".repeat(1023)}\n`;
      const chunk = new TextEncoder().encode(line.repeat(1024));
      // One chunk past V8's longest string (2 ** 29 - 24 characters).
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
