import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxCommandResult, SandboxSession } from "#shared/sandbox-session.js";

import { executeBashOnSandbox } from "./bash.js";
import { createBashJobId } from "./bash-jobs.js";

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
    const jobId = createBashJobId("session-1/call-1");
    const sandbox = createTestSandboxSession({
      exitCode: 0,
      stderr: "",
      stdout: `eve-job:v1:${jobId} exited 0 0 0 ${jobId}\nweather-codes.md\n`,
    });

    const result = await executeBashOnSandbox(
      sandbox,
      { command: "ls -la /workspace" },
      { jobKey: "session-1/call-1" },
    );

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

  it("returns a still-running command as a job the model can wait on or stop", async () => {
    const jobId = createBashJobId("session-1/call-1");
    const sandbox = createTestSandboxSession({
      exitCode: 0,
      stderr: "",
      stdout: `eve-job:v1:${jobId} running - 0 0 ${jobId}\nindexing 1/9\n`,
    });

    const result = await executeBashOnSandbox(
      sandbox,
      { command: "grep -r TODO /" },
      { jobKey: "session-1/call-1" },
    );

    expect(result).toMatchObject({
      status: "running",
      stderr: "",
      stdout: "indexing 1/9\n",
      truncated: false,
    });
    if (result.status !== "running") throw new Error("expected a running job");
    expect(result.message).toContain(`eve-job wait ${result.jobId}`);
    expect(result.message).toContain(`eve-job stop ${result.jobId}`);
  });
});

function createTestSandboxSession(result: SandboxCommandResult): SandboxSession {
  return {
    readBinaryFile: async () => null,
    readFile: async () => null,
    readTextFile: async () => null,
    removePath: async () => {},
    resolvePath: (path) => path,
    run: vi.fn().mockResolvedValue(result),
    spawn: async () => {
      throw new Error("spawn is not implemented in this test sandbox");
    },
    writeBinaryFile: async () => {},
    writeFile: async () => {},
    writeTextFile: async () => {},
  };
}
