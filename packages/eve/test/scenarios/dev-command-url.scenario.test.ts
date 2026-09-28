import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const createScratchDirectory = useTemporaryDirectories();
const DEV_URL_ENV_KEY = "EVE_DEV_URL_ENV_FROM_FILE";

async function createTemporaryRoot(): Promise<string> {
  return await createScratchDirectory("eve-dev-command-");
}

function restoreInteractiveTerminal(): void {
  if (stdinTtyDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }

  if (stdoutTtyDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

function setInteractiveTerminal(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
}

afterEach(() => {
  delete process.env[DEV_URL_ENV_KEY];
  restoreInteractiveTerminal();
  vi.restoreAllMocks();
});

describe("eve remote connect", () => {
  it("connects the terminal UI without starting a local server", async () => {
    setInteractiveTerminal();

    const logger = { error: vi.fn(), log: vi.fn() };
    const startHost = vi.fn();
    const runDevelopmentTui = vi.fn(async () => {});

    await runCli(["remote", "connect", "--url", "https://example.com"], logger, {
      runDevelopmentTui,
      startHost,
    });

    expect(startHost).not.toHaveBeenCalled();
    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          kind: "remote",
          serverUrl: "https://example.com/",
        }),
      }),
    );
    const output = logger.log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output).toContain("↗ remote agent");
    expect(output).toContain("example.com");
  });

  it("loads local development env files before connecting", async () => {
    const appRoot = await createTemporaryRoot();
    const canonicalAppRoot = await realpath(appRoot);
    const previousCwd = process.cwd();
    const logger = { error: vi.fn(), log: vi.fn() };
    const startHost = vi.fn();
    const runDevelopmentTui = vi.fn(async () => {});

    await writeFile(join(appRoot, ".env"), `${DEV_URL_ENV_KEY}=from-env\n`);

    setInteractiveTerminal();
    process.chdir(appRoot);

    try {
      await runCli(["remote", "connect", "--url", "https://example.com"], logger, {
        runDevelopmentTui,
        startHost,
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(process.env[DEV_URL_ENV_KEY]).toBe("from-env");
    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: canonicalAppRoot,
        },
      }),
    );
  });
});
