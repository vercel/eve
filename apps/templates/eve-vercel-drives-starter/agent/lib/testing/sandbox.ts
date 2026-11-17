/**
 * Vercel Sandbox SDK fixtures for unit tests. Each fixture is a real SDK
 * instance built from metadata, which makes no API requests; only the methods
 * that would reach the Sandbox API are replaced with spies.
 *
 * @packageDocumentation
 */
import { CommandFinished, Drive, Sandbox } from "@vercel/sandbox";
import { vi } from "vitest";

/**
 * Builds a real SDK Drive from metadata.
 *
 * @param currentSessionId - Sandbox session holding the read-write mount, if any.
 * @returns A Drive whose metadata reports the given attachment.
 */
export const driveFixture = (currentSessionId?: string) =>
  new Drive({
    drive: {
      createdAt: 0,
      currentSessionId,
      id: "drive_1",
      maxSizeBytes: 1024,
      name: "eve-drive",
      projectId: "prj_1",
      region: "iad1",
      updatedAt: 0,
    },
  });

/**
 * Builds a real SDK command result with cached output, so reading it makes no API request.
 *
 * @param exitCode - Process exit code.
 * @param stderr - Captured standard error.
 * @returns A finished command.
 */
export const commandFinished = (exitCode = 0, stderr = "") =>
  new CommandFinished({
    cmd: {
      args: [],
      cwd: "/",
      exitCode,
      id: "cmd_1",
      name: "command",
      sessionId: "sess_write",
      startedAt: 0,
    },
    exitCode,
    output: { stderr, stdout: "" },
    sessionId: "sess_write",
  });

/**
 * Builds a real SDK sandbox whose API-backed methods used by the Drive code are spies.
 *
 * @returns The sandbox and its `runCommand`, `writeFiles`, and `stop` spies, which succeed by default.
 * @remarks Spies are installed on every call so no test reaches the Sandbox API, including after vitest resets mocks.
 */
export const sandboxFixture = () => {
  const sandbox = Object.assign(
    new Sandbox({
      routes: [],
      sandbox: {
        createdAt: 0,
        currentSessionId: "sess_write",
        name: "drive-writer",
        persistent: false,
        status: "running",
        updatedAt: 0,
      },
    }),
    {
      [Symbol.asyncDispose]: vi.fn<() => Promise<void>>().mockResolvedValue(),
    }
  );
  return {
    runCommand: vi
      .spyOn(sandbox, "runCommand")
      .mockResolvedValue(commandFinished()),
    sandbox,
    stop: vi.spyOn(sandbox, "stop").mockResolvedValue({
      createdAt: 0,
      cwd: "/",
      id: "sess_write",
      memory: 2048,
      region: "iad1",
      requestedAt: 0,
      status: "stopped",
      timeout: 300_000,
      updatedAt: 0,
      vcpus: 1,
    }),
    writeFiles: vi.spyOn(sandbox, "writeFiles").mockResolvedValue(),
  };
};

/**
 * Routes the SDK's Drive and Sandbox factories to spies for one test.
 *
 * @returns Spies for `Drive.getOrCreate` and `Sandbox.create` that reject until a test configures them.
 * @remarks Call from `beforeEach`; `restoreMocks` restores the real factories after each test.
 */
export const spyOnSandboxFactories = () => ({
  create: vi
    .spyOn(Sandbox, "create")
    .mockRejectedValue(new Error("Unexpected Sandbox.create call.")),
  getOrCreate: vi
    .spyOn(Drive, "getOrCreate")
    .mockRejectedValue(new Error("Unexpected Drive.getOrCreate call.")),
});
