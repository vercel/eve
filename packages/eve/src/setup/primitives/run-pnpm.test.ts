import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  eveDevArguments,
  runPackageManagerInstall,
  runPnpmInstall,
  spawnPnpm,
} from "./run-pnpm.js";
import { packageManagerInstallSucceeded } from "./pm/run.js";
import { resultSucceeded } from "./pm/process-result.js";
import { pnpmPackageManager } from "./pm/pnpm.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

const mockedSpawn = vi.mocked(spawn);
const mockedExistsSync = vi.mocked(existsSync);

function createMockChildProcess() {
  return Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

mockedSpawn.mockImplementation(() => {
  const child = createMockChildProcess();
  queueMicrotask(() => child.emit("close", 0));
  return child;
});

function mockMembershipProbe(paths: readonly string[]): void {
  const child = createMockChildProcess();
  mockedSpawn.mockReturnValueOnce(child);
  queueMicrotask(() => {
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify(paths.map((path) => ({ name: "test", path })))),
    );
    child.emit("close", 0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedExistsSync.mockReturnValue(false);
  vi.stubEnv("PNPM_HOME", undefined);
  vi.stubEnv("npm_execpath", undefined);
  vi.stubEnv("npm_config_user_agent", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runPnpmInstall", () => {
  test("updates an existing lockfile after scaffolded dependencies change", async () => {
    expect(packageManagerInstallSucceeded(await runPnpmInstall("/tmp/eve-agent"))).toBe(true);

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--dir", "/tmp/eve-agent", "install", "--no-frozen-lockfile"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", stdio: ["inherit", "pipe", "pipe"] }),
    );
  });

  test("installs a claimed workspace member with native workspace semantics", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/tmp/pnpm-workspace.yaml");
    mockMembershipProbe(["/tmp", "/tmp/eve-agent"]);

    expect(packageManagerInstallSucceeded(await runPnpmInstall("/tmp/eve-agent"))).toBe(true);

    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(mockedSpawn).toHaveBeenLastCalledWith(
      "pnpm",
      ["--dir", "/tmp/eve-agent", "install", "--no-frozen-lockfile"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", stdio: ["inherit", "pipe", "pipe"] }),
    );
  });

  test("installs standalone immediately when the ancestor workspace does not claim the project", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/tmp/pnpm-workspace.yaml");
    mockMembershipProbe(["/tmp"]);

    expect(packageManagerInstallSucceeded(await runPnpmInstall("/tmp/eve-agent"))).toBe(true);

    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(mockedSpawn).toHaveBeenLastCalledWith(
      "pnpm",
      ["--dir", "/tmp/eve-agent", "install", "--no-frozen-lockfile", "--ignore-workspace"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", stdio: ["inherit", "pipe", "pipe"] }),
    );
  });

  test("streams install output when setup supplies an output handler", async () => {
    const child = createMockChildProcess();
    mockedSpawn.mockReturnValueOnce(child);
    const onOutput = vi.fn();

    const result = runPnpmInstall("/tmp/eve-agent", { onOutput });
    child.stdout.emit("data", Buffer.from("Packages: +12\n"));
    child.stderr.emit("data", Buffer.from("WARN deprecated package\n"));
    child.emit("close", 0);

    expect(packageManagerInstallSucceeded(await result)).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--dir", "/tmp/eve-agent", "install", "--no-frozen-lockfile"],
      expect.objectContaining({ stdio: ["inherit", "pipe", "pipe"] }),
    );
    expect(onOutput.mock.calls.map(([line]) => line)).toEqual([
      { stream: "stdout", text: "Packages: +12" },
      { stream: "stderr", text: "WARN deprecated package" },
    ]);
  });

  test("replays stdout when the ancestor workspace probe fails", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/tmp/pnpm-workspace.yaml");
    const child = createMockChildProcess();
    mockedSpawn.mockReturnValueOnce(child);
    const onOutput = vi.fn();

    const result = runPnpmInstall("/tmp/eve-agent", { onOutput });
    child.stdout.emit("data", Buffer.from("workspace parse failed\n"));
    child.emit("close", 1);

    expect((await result).kind).toBe("workspace-probe-failed");
    expect(onOutput.mock.calls.map(([line]) => line)).toEqual([
      { stream: "stdout", text: "workspace parse failed" },
    ]);
  });
});

describe("runPackageManagerInstall", () => {
  test.each([
    [
      "pnpm",
      ["--dir", "/tmp/app", "install", "--no-frozen-lockfile", "--config.minimum-release-age=0"],
    ],
    ["npm", ["install", "--min-release-age=0"]],
    // yarn has no release-age gate, so the bypass adds nothing.
    ["yarn", ["install"]],
    ["bun", ["install"]],
  ] as const)("maps the release-age bypass onto %s", async (kind, expectedArgs) => {
    expect(
      packageManagerInstallSucceeded(
        await runPackageManagerInstall(kind, "/tmp/app", { bypassMinimumReleaseAge: true }),
      ),
    ).toBe(true);

    expect(mockedSpawn).toHaveBeenCalledWith(
      kind,
      expectedArgs,
      expect.objectContaining({ cwd: "/tmp/app" }),
    );
  });

  test("requests npm output before registry operations complete", async () => {
    expect(
      packageManagerInstallSucceeded(
        await runPackageManagerInstall("npm", "/tmp/app", { progressDetails: true }),
      ),
    ).toBe(true);

    expect(mockedSpawn).toHaveBeenCalledWith(
      "npm",
      ["install", "--loglevel=silly"],
      expect.objectContaining({ cwd: "/tmp/app" }),
    );
  });
});

describe("eveDevArguments", () => {
  test.each([
    ["npm", ["exec", "--", "eve", "dev"]],
    ["pnpm", ["exec", "eve", "dev"]],
    ["yarn", ["eve", "dev"]],
    ["bun", ["x", "eve", "dev"]],
  ] as const)("maps %s to its local-binary invocation", (kind, expectedArgs) => {
    expect(eveDevArguments(kind)).toEqual(expectedArgs);
  });
});

describe("pnpmPackageManager", () => {
  test("prefers the active pnpm npm_execpath over PNPM_HOME", () => {
    vi.stubEnv("PNPM_HOME", "/old/pnpm-home");
    vi.stubEnv("npm_execpath", "/active/pnpm.cjs");
    mockedExistsSync.mockReturnValue(true);

    expect(pnpmPackageManager.resolveInvocation(["install"])).toEqual({
      args: ["/active/pnpm.cjs", "install"],
      command: process.execPath,
    });
  });

  test("uses PATH pnpm under pnpm when npm_execpath is not available", () => {
    vi.stubEnv("PNPM_HOME", "/old/pnpm-home");
    vi.stubEnv("npm_config_user_agent", "pnpm/11.5.2 npm/? node/v24.15.0 darwin arm64");
    mockedExistsSync.mockReturnValue(true);

    expect(pnpmPackageManager.resolveInvocation(["install"])).toEqual({
      args: ["install"],
      command: "pnpm",
      shell: process.platform === "win32",
    });
  });
});

describe("spawnPnpm", () => {
  test("runs the given pnpm argv in the project directory", async () => {
    expect(
      resultSucceeded(await spawnPnpm("/tmp/eve-agent", ["exec", "eve", "dev", "--no-ui"])),
    ).toBe(true);

    expect(mockedSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--dir", "/tmp/eve-agent", "exec", "eve", "dev", "--no-ui"],
      expect.objectContaining({ cwd: "/tmp/eve-agent", stdio: ["inherit", "pipe", "pipe"] }),
    );
  });

  test("passes cancellation to the child and settles as unsuccessful", async () => {
    const child = createMockChildProcess();
    mockedSpawn.mockReturnValueOnce(child);
    const controller = new AbortController();

    const result = spawnPnpm("/tmp/eve-agent", ["install"], {
      signal: controller.signal,
    });
    expect(mockedSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--dir", "/tmp/eve-agent", "install"],
      expect.objectContaining({ signal: controller.signal }),
    );

    controller.abort();
    const error: NodeJS.ErrnoException = new Error("The operation was aborted");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    child.emit("error", error);
    await expect(result).resolves.toMatchObject({ termination: { kind: "aborted" } });
    child.emit("close", null);
  });
});
