import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run.js";
import { resolveInstalledPackageInfo } from "../../src/internal/application/package.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  EVE_CONTINUE_SESSION_ROUTE_PATTERN,
  EVE_CREATE_SESSION_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_MESSAGE_STREAM_ROUTE_PATTERN,
} from "../../src/protocol/routes.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));
const scenarioApp = useScenarioApp();
const createScratchDirectory = useTemporaryDirectories();
const CLI_BUILD_ENV_KEYS = [
  "EVE_BUILD_DEFAULT_ONLY",
  "EVE_BUILD_DEVELOPMENT_LOCAL_ONLY",
  "EVE_BUILD_DEVELOPMENT_ONLY",
  "EVE_BUILD_LOCAL_ONLY",
  "EVE_BUILD_SHARED",
  "EVE_BUILD_SHELL_ONLY",
] as const;

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return logger.log.mock.calls.map(([message]) => String(message)).join("\n");
}

function clearCliBuildEnvironment(): void {
  for (const key of CLI_BUILD_ENV_KEYS) {
    delete process.env[key];
  }
}

interface RunningEveStart {
  readonly url: string;
  stderr(): string;
  stdout(): string;
  stop(): Promise<void>;
}

async function createMinimalAppRoot(prefix: string): Promise<string> {
  const appRoot = await createScratchDirectory(prefix);

  await mkdir(join(appRoot, "agent"), {
    recursive: true,
  });
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "eve-cli-start-health-test",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(appRoot, "agent", "agent.mjs"),
    'export default { model: "openai/gpt-5.4" };\n',
  );
  await writeFile(join(appRoot, "agent", "instructions.md"), "You are a precise assistant.\n");

  return appRoot;
}

async function startPackagedEveStart(appRoot: string): Promise<RunningEveStart> {
  const child = spawn(
    process.execPath,
    [EVE_BIN_PATH, "start", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let url: string;
  try {
    url = await waitForStartUrl({
      child,
      getOutput: () => ({
        stderr,
        stdout,
      }),
    });
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChildProcess(child);
    },
    url,
  };
}

async function waitForStartUrl(input: {
  readonly child: ChildProcess;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const output = input.getOutput();
    const url = parseStartUrl(output.stdout);

    if (url !== undefined) {
      return url;
    }

    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error(
        [
          `eve start exited before printing its server URL (code ${String(
            input.child.exitCode,
          )}, signal ${String(input.child.signalCode)}).`,
          `stdout:\n${output.stdout}`,
          `stderr:\n${output.stderr}`,
        ].join("\n\n"),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const output = input.getOutput();
  throw new Error(
    [
      "Timed out waiting for eve start to print its server URL.",
      `stdout:\n${output.stdout}`,
      `stderr:\n${output.stderr}`,
    ].join("\n\n"),
  );
}

function parseStartUrl(output: string): string | undefined {
  const match = /\[START\] server listening at (https?:\/\/[^\s]+)/.exec(output);
  return match?.[1];
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

afterEach(() => {
  clearCliBuildEnvironment();
});

describe("runCli", () => {
  it("prints the installed package version for --version", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const evePackage = resolveInstalledPackageInfo();

    await runCli(["--version"], logger);

    expect(getLogOutput(logger)).toBe(evePackage.version);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("prints the installed package version when running a CLI command", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const evePackage = resolveInstalledPackageInfo();

    await runCli(["info"], logger);

    const output = getLogOutput(logger);
    expect(output).toContain("eve");
    expect(output).toContain(`v${evePackage.version}`);
  });

  it("does not print the startup banner before JSON eval output", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const runEvalCommand = vi.fn(async () => {
      logger.log("{}");
    });

    await runCli(["eval", "--json"], logger, {
      runEvalCommand,
    });

    expect(getLogOutput(logger)).toBe("{}");
  });

  it("prints fixture information", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await runCli(["info"], logger);

    expect(logger.log).toHaveBeenCalled();
    expect(getLogOutput(logger)).toContain("eve Info");
    expect(getLogOutput(logger)).toContain("Application");
    expect(getLogOutput(logger)).toContain("Workflow ID");
    expect(getLogOutput(logger)).toContain(`POST ${EVE_CREATE_SESSION_ROUTE_PATH}`);
    expect(getLogOutput(logger)).toContain(`POST ${EVE_CONTINUE_SESSION_ROUTE_PATTERN}`);
    expect(getLogOutput(logger)).toContain(`GET ${EVE_MESSAGE_STREAM_ROUTE_PATTERN}`);
  });

  it("prints compiled discovery metadata when run inside an eve app", async () => {
    const fixtureApp = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
    const resolvedFixtureRoot = await realpath(fixtureApp.appRoot);
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    process.chdir(fixtureApp.appRoot);

    try {
      await runCli(["info"], logger);
    } finally {
      process.chdir(previousCwd);
    }

    const output = getLogOutput(logger);

    expect(output).toContain(resolvedFixtureRoot);
    expect(output).toContain(join(resolvedFixtureRoot, "agent"));
    expect(output).toContain("nested");
    expect(output).toContain(join(resolvedFixtureRoot, ".eve", "compile", "module-map.mjs"));
    expect(output).toContain("instructions.md");
    expect(output).toContain("ready");
    expect(output).toContain("0 errors, 0 warnings");
  });

  it("defaults to dev when no command is provided", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const startHost = vi.fn(() => ({
      start: async () => {
        throw new Error("dev started");
      },
      close: async () => {},
    }));

    await expect(
      runCli([], logger, {
        startHost,
      }),
    ).rejects.toThrow("dev started");

    expect(startHost).toHaveBeenCalledOnce();
  });

  it("throws on unsupported commands", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await expect(runCli(["nope"], logger)).rejects.toThrow(/unknown command/i);
    expect(logger.error).toHaveBeenCalled();
  });

  it("rejects non-numeric ports", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await expect(runCli(["dev", "--port", "abc"], logger)).rejects.toThrow(
      'Expected a numeric port, received "abc".',
    );
  });

  it("rejects negative ports", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await expect(runCli(["dev", "--port", "-1"], logger)).rejects.toThrow(
      'Expected a port between 0 and 65535, received "-1".',
    );
  });

  it("rejects ports above 65535", async () => {
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await expect(runCli(["dev", "--port", "70000"], logger)).rejects.toThrow(
      'Expected a port between 0 and 65535, received "70000".',
    );
  });

  it("passes host and port to the production start host", async () => {
    const workspaceRoot = await createScratchDirectory("eve-cli-start-options-");
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const startProductionHost = vi.fn(async () => {
      throw new Error("stop after start option capture");
    });

    process.chdir(workspaceRoot);

    try {
      await expect(
        runCli(["start", "--host", "127.0.0.1", "--port", "0"], logger, {
          startProductionHost,
        }),
      ).rejects.toThrow("stop after start option capture");
    } finally {
      process.chdir(previousCwd);
    }

    expect(startProductionHost).toHaveBeenCalledWith(resolvedWorkspaceRoot, {
      host: "127.0.0.1",
      port: 0,
    });
  });

  it("fails clearly when start runs before build output exists", async () => {
    const workspaceRoot = await createScratchDirectory("eve-cli-start-missing-output-");
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    process.chdir(workspaceRoot);

    try {
      await expect(runCli(["start"], logger)).rejects.toThrow(
        `Missing eve build output at ${join(
          resolvedWorkspaceRoot,
          ".output",
          "server",
          "index.mjs",
        )}. Run "eve build" before "eve start".`,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("starts an existing built app and serves the health route", async () => {
    const { buildApplication } = await import("../../src/internal/nitro/host.js");
    const appRoot = await createMinimalAppRoot("eve-cli-start-health-");

    await buildApplication(appRoot);

    const server = await startPackagedEveStart(appRoot);

    try {
      const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
      const responseJson = (await response.json()) as { ok?: unknown; status?: unknown };

      expect(response.status).toBe(200);
      expect(responseJson).toMatchObject({ ok: true, status: "ready" });
      expect(server.stdout()).toContain("[START] server listening at");
    } finally {
      await server.stop();
    }
  }, 120_000);

  it("surfaces discovery diagnostics in build failures", async () => {
    const workspaceRoot = await createScratchDirectory("eve-cli-build-diagnostics-");
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };

    await mkdir(join(workspaceRoot, "agent"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ name: "build-diagnostics" }, null, 2)}\n`,
    );
    await writeFile(
      join(workspaceRoot, "agent", "agent.mjs"),
      'export default { model: "openai/gpt-5.4" };\n',
    );
    // No instructions.md or instructions.ts â discovery should fail with
    // DISCOVER_REQUIRED_INSTRUCTIONS_MISSING.

    process.chdir(workspaceRoot);

    let thrownError: unknown;

    try {
      await runCli(["build"], logger);
    } catch (error) {
      thrownError = error;
    } finally {
      process.chdir(previousCwd);
    }

    expect(thrownError).toBeInstanceOf(Error);

    if (!(thrownError instanceof Error)) {
      throw new Error("Expected runCli build to throw an Error.");
    }

    expect(thrownError.message).toContain("Discovery failed with 1 error(s) and 0 warning(s).");
    expect(thrownError.message).toContain(
      `Diagnostics artifact: ${join(resolvedWorkspaceRoot, ".eve", "discovery", "diagnostics.json")}`,
    );
    expect(thrownError.message).toContain("Discovery diagnostics:");
    expect(thrownError.message).toContain(
      'Expected authored instructions at "instructions.md", "instructions.ts", "instructions.cts", "instructions.mts", "instructions.js", "instructions.cjs", "instructions.mjs", or "instructions/" directory.',
    );
    expect(thrownError.message).toContain(`source: ${join(resolvedWorkspaceRoot, "agent")}`);
  });

  it("loads development env files before running build", async () => {
    const workspaceRoot = await createScratchDirectory("eve-cli-build-env-");
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const observedEnvironment: Record<string, string | undefined> = {};
    const buildHost = vi.fn(async () => {
      for (const key of CLI_BUILD_ENV_KEYS) {
        observedEnvironment[key] = process.env[key];
      }

      return join(workspaceRoot, ".vercel", "output");
    });

    await writeFile(
      join(workspaceRoot, ".env"),
      [
        "EVE_BUILD_DEFAULT_ONLY=from-env",
        "EVE_BUILD_SHARED=from-env",
        "EVE_BUILD_SHELL_ONLY=from-env",
      ].join("\n"),
    );
    await writeFile(
      join(workspaceRoot, ".env.development"),
      "EVE_BUILD_DEVELOPMENT_ONLY=from-development\n",
    );
    await writeFile(
      join(workspaceRoot, ".env.local"),
      ["EVE_BUILD_LOCAL_ONLY=from-local", "EVE_BUILD_SHARED=from-local"].join("\n"),
    );
    await writeFile(
      join(workspaceRoot, ".env.development.local"),
      "EVE_BUILD_DEVELOPMENT_LOCAL_ONLY=from-development-local\n",
    );

    process.env.EVE_BUILD_SHELL_ONLY = "from-shell";
    process.chdir(workspaceRoot);

    try {
      await runCli(["build"], logger, {
        buildHost,
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(buildHost).toHaveBeenCalledWith(resolvedWorkspaceRoot);
    expect(observedEnvironment).toEqual({
      EVE_BUILD_DEFAULT_ONLY: "from-env",
      EVE_BUILD_DEVELOPMENT_LOCAL_ONLY: "from-development-local",
      EVE_BUILD_DEVELOPMENT_ONLY: "from-development",
      EVE_BUILD_LOCAL_ONLY: "from-local",
      EVE_BUILD_SHARED: "from-local",
      EVE_BUILD_SHELL_ONLY: "from-shell",
    });
  });
});
