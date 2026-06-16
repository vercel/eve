import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxCommandResult, SandboxSession } from "#shared/sandbox-session.js";

import { executeBashOnSandbox } from "./bash-tool.js";

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
});

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
