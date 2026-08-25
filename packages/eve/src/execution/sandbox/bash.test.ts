import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxCommandResult, SandboxSession } from "#shared/sandbox-session.js";

import { DEFAULT_BASH_TIMEOUT_SECONDS, executeBashOnSandbox } from "./bash.js";

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
      stderr: "",
      stdout: "weather-codes.md\n",
      truncated: false,
    });
    expect(log).toHaveBeenCalledWith("eve: starting sandbox command: ls -la /workspace");
    expect(log).toHaveBeenCalledWith("eve: sandbox command finished (exit 0): ls -la /workspace");
  });

  it.each([
    {
      expectedTimeoutMs: DEFAULT_BASH_TIMEOUT_SECONDS * 1_000,
      input: { command: "sleep forever" },
      scenario: "uses the default timeout",
    },
    {
      expectedTimeoutMs: 10_000,
      input: { command: "sleep forever", timeout: 10 },
      scenario: "honors a shorter requested timeout",
    },
    {
      expectedTimeoutMs: 1_200_000,
      input: { command: "sleep forever", timeout: 1_200 },
      scenario: "honors a requested timeout above ten minutes",
    },
  ])("$scenario", async ({ expectedTimeoutMs, input }) => {
    const { abort, timeout } = mockTimeoutSignal();
    const execution = executeBashOnSandbox(createAbortingTestSandboxSession(), input);
    const rejection = expect(execution).rejects.toMatchObject({ name: "TimeoutError" });

    expect(timeout).toHaveBeenCalledWith(expectedTimeoutMs);
    abort();

    await rejection;
  });

  it("composes the command timeout with turn cancellation", async () => {
    const controller = new AbortController();
    const sandbox = createAbortingTestSandboxSession();
    const execution = executeBashOnSandbox(
      sandbox,
      { command: "sleep forever" },
      { abortSignal: controller.signal },
    );
    const rejection = expect(execution).rejects.toMatchObject({ name: "AbortError" });

    controller.abort(new DOMException("The turn was cancelled.", "AbortError"));

    await rejection;
  });
});

function mockTimeoutSignal() {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  return {
    abort: () => controller.abort(new DOMException("The command timed out.", "TimeoutError")),
    timeout,
  };
}

function createAbortingTestSandboxSession(): SandboxSession {
  const sandbox = createTestSandboxSession({ exitCode: 0, stderr: "", stdout: "" });
  return {
    ...sandbox,
    run: vi.fn(
      async ({ abortSignal }) =>
        await new Promise<SandboxCommandResult>((_resolve, reject) => {
          if (abortSignal?.aborted === true) {
            reject(abortSignal.reason);
            return;
          }
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        }),
    ),
  };
}

function createTestSandboxSession(result: SandboxCommandResult): SandboxSession {
  return {
    id: "test-sandbox",
    readBinaryFile: async () => null,
    readFile: async () => null,
    readTextFile: async () => null,
    removePath: async () => {},
    resolvePath: (path) => path,
    run: vi.fn().mockResolvedValue(result),
    setNetworkPolicy: async () => {},
    spawn: async () => {
      throw new Error("spawn is not implemented in this test sandbox");
    },
    writeBinaryFile: async () => {},
    writeFile: async () => {},
    writeTextFile: async () => {},
  };
}
