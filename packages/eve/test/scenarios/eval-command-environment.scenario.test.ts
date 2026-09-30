import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defineEvalConfig } from "../../src/evals/define-eval-config.js";
import { defineEval } from "../../src/evals/define-eval.js";

import { runCli } from "../../src/cli/run.js";
import {
  shutdownActiveSandboxHandles,
  trackActiveSandboxHandle,
} from "../../src/execution/sandbox/active-handles.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const mockedEvalDependencies = vi.hoisted(() => ({
  createDevelopmentServer: vi.fn(),
  discoverAndImportEvals: vi.fn(),
  discoverEvalConfig: vi.fn(),
  executeEval: vi.fn(),
  resolveEvalTargetHandle: vi.fn(),
}));

vi.mock("../../src/evals/runner/discover.js", () => ({
  discoverAndImportEvals: mockedEvalDependencies.discoverAndImportEvals,
  discoverEvalConfig: mockedEvalDependencies.discoverEvalConfig,
}));

vi.mock("../../src/evals/runner/execute-eval.js", () => ({
  executeEval: mockedEvalDependencies.executeEval,
}));

vi.mock("../../src/evals/target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/evals/target.js")>()),
  resolveEvalTargetHandle: mockedEvalDependencies.resolveEvalTargetHandle,
}));

vi.mock("../../src/internal/nitro/host.js", () => ({
  createDevelopmentServer: mockedEvalDependencies.createDevelopmentServer,
}));

const createScratchDirectory = useTemporaryDirectories();

const DEVELOPMENT_ENV_KEYS = [
  "EVE_DEV_DEFAULT_ONLY",
  "EVE_DEV_DEVELOPMENT_LOCAL_ONLY",
  "EVE_DEV_DEVELOPMENT_ONLY",
  "EVE_DEV_LOCAL_ONLY",
  "EVE_DEV_SHARED",
  "EVE_DEV_SHELL_ONLY",
  "EVE_EVALUATION",
  "EVE_EVALUATION_RUN_ID",
] as const;

async function createEnvironmentFixture(): Promise<string> {
  const fixtureRoot = await createScratchDirectory("eve-eval-env-");

  await mkdir(join(fixtureRoot, "agent"), { recursive: true });
  await writeFile(
    join(fixtureRoot, "package.json"),
    `${JSON.stringify({ dependencies: { eve: "*" }, name: "eve-eval-env-test", private: true, type: "module" })}\n`,
  );
  await writeFile(
    join(fixtureRoot, "agent", "agent.mjs"),
    'export default { model: "openai/gpt-5.4" };\n',
  );
  await writeFile(join(fixtureRoot, "agent", "instructions.md"), "You are a precise assistant.\n");

  await writeFile(
    join(fixtureRoot, ".env"),
    [
      "EVE_DEV_DEFAULT_ONLY=from-env",
      "EVE_DEV_SHARED=from-env",
      "EVE_DEV_SHELL_ONLY=from-env",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.development"),
    ["EVE_DEV_DEVELOPMENT_ONLY=from-development"].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.local"),
    ["EVE_DEV_LOCAL_ONLY=from-local", "EVE_DEV_SHARED=from-local"].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.development.local"),
    ["EVE_DEV_DEVELOPMENT_LOCAL_ONLY=from-development-local"].join("\n"),
  );

  return fixtureRoot;
}

function clearDevelopmentEnvironment(): void {
  for (const key of DEVELOPMENT_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(async () => {
  clearDevelopmentEnvironment();
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await shutdownActiveSandboxHandles();
  mockedEvalDependencies.createDevelopmentServer.mockReset();
  mockedEvalDependencies.discoverAndImportEvals.mockReset();
  mockedEvalDependencies.discoverEvalConfig.mockReset();
  mockedEvalDependencies.executeEval.mockReset();
  mockedEvalDependencies.resolveEvalTargetHandle.mockReset();
});

const TEST_CONFIG = {
  _tag: "EveEvalConfig" as const,
  judge: { model: "openai/gpt-5.4-mini" },
};

describe("eve eval environment loading", () => {
  it("shares live setup resources with every eval and teardown", async () => {
    const fixture = await createEvalSetupFixture();
    class Database {
      #queries = 0;
      readonly marker = 1n;
      closed = false;
      query() {
        if (this.closed) throw new Error("Database is closed");
        return ++this.#queries;
      }
      close() {
        this.closed = true;
      }
    }
    const database = new Database();
    const config = defineEvalConfig({
      async setup() {
        await fixture.setup();
        return database;
      },
      teardown(context) {
        expect(context).toBe(database);
        expect(database.query()).toBe(3);
        context?.close();
      },
    });
    const evaluation = defineEval<typeof config>({
      test(t) {
        expect(t.context).toBe(database);
        expect(t.context.query()).toBeGreaterThan(0);
      },
    });
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue(config);
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([
      { ...evaluation, id: "first" },
      { ...evaluation, id: "second" },
    ]);
    const { executeEval } = await vi.importActual<
      typeof import("../../src/evals/runner/execute-eval.js")
    >("../../src/evals/runner/execute-eval.js");
    mockedEvalDependencies.executeEval.mockImplementation(executeEval);

    await fixture.run();

    expect(database.closed).toBe(true);
    expect(fixture.exit).toHaveBeenCalledWith(0);
    expect(fixture.close.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.exit.mock.invocationCallOrder[0]!,
    );
  });

  it("runs setup once before local startup and tears down after server shutdown", async () => {
    const fixture = await createEvalSetupFixture();

    await fixture.run();

    expect(fixture.setup).toHaveBeenCalledTimes(1);
    expect(mockedEvalDependencies.executeEval).toHaveBeenCalledTimes(2);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.setup.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.start.mock.invocationCallOrder[0]!,
    );
    expect(fixture.close.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.teardown.mock.invocationCallOrder[0]!,
    );
    expect(fixture.exit).toHaveBeenCalledWith(0);
  });

  it("runs setup and teardown locally for a remote target", async () => {
    const fixture = await createEvalSetupFixture();
    mockedEvalDependencies.resolveEvalTargetHandle.mockResolvedValue({
      kind: "remote",
      url: "https://example.com",
    });

    await fixture.run(["--url", "https://example.com"]);

    expect(fixture.setup).toHaveBeenCalledTimes(1);
    expect(fixture.setup.mock.invocationCallOrder[0]).toBeLessThan(
      mockedEvalDependencies.resolveEvalTargetHandle.mock.invocationCallOrder[0]!,
    );
    expect(mockedEvalDependencies.createDevelopmentServer).not.toHaveBeenCalled();
    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.exit).toHaveBeenCalledWith(0);
  });

  it("tears down resources when local startup fails", async () => {
    const fixture = await createEvalSetupFixture();
    fixture.start.mockRejectedValueOnce(new Error("fixture startup failed"));

    await expect(fixture.run()).rejects.toThrow("fixture startup failed");

    expect(mockedEvalDependencies.executeEval).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.close.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.teardown.mock.invocationCallOrder[0]!,
    );
  });

  it("tears down resources and fails the command when an eval fails", async () => {
    const fixture = await createEvalSetupFixture();
    mockedEvalDependencies.executeEval.mockResolvedValueOnce(makeEvalResult("beta"));

    await fixture.run();

    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it("still tears down resources when server shutdown fails", async () => {
    const fixture = await createEvalSetupFixture();
    fixture.close.mockRejectedValueOnce(new Error("fixture close failed"));

    await fixture.run();

    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.logger.error).toHaveBeenCalledWith("Eval cleanup failed: fixture close failed");
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it("fails the command when teardown fails", async () => {
    const fixture = await createEvalSetupFixture();
    fixture.teardown.mockRejectedValueOnce(new Error("fixture teardown failed"));

    await fixture.run();

    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      "Eval cleanup failed: fixture teardown failed",
    );
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it("runs teardown without starting a target when setup fails", async () => {
    const fixture = await createEvalSetupFixture();
    fixture.setup.mockRejectedValueOnce(new Error("fixture setup failed"));
    fixture.teardown.mockResolvedValueOnce(undefined);

    await expect(fixture.run()).rejects.toThrow("fixture setup failed");

    expect(mockedEvalDependencies.createDevelopmentServer).not.toHaveBeenCalled();
    expect(mockedEvalDependencies.resolveEvalTargetHandle).not.toHaveBeenCalled();
    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.teardown).toHaveBeenCalledWith(undefined);
  });

  it("preserves the setup error when teardown also fails", async () => {
    const fixture = await createEvalSetupFixture();
    fixture.setup.mockRejectedValueOnce(new Error("fixture setup failed"));
    fixture.teardown.mockRejectedValueOnce(new Error("fixture teardown failed"));

    await expect(fixture.run()).rejects.toThrow("fixture setup failed");

    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      "Eval cleanup failed: fixture teardown failed",
    );
  });

  it("runs teardown without a setup callback", async () => {
    const fixture = await createEvalSetupFixture();
    fixture.teardown.mockResolvedValueOnce(undefined);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue({
      ...TEST_CONFIG,
      teardown: fixture.teardown,
    });
    mockedEvalDependencies.executeEval.mockResolvedValue(makeEvalResult("first"));

    await fixture.run(["--url", "https://example.com"]);

    expect(fixture.setup).not.toHaveBeenCalled();
    expect(mockedEvalDependencies.executeEval).toHaveBeenCalledTimes(2);
    expect(fixture.teardown).toHaveBeenCalledTimes(1);
    expect(fixture.exit).toHaveBeenCalledWith(0);
  });

  it.each([
    { name: "listing evals", args: ["--list"] },
    { name: "excluding all evals", args: ["--exclude-tag", "setup"] },
  ])("skips setup when $name", async ({ args }) => {
    const fixture = await createEvalSetupFixture();

    await fixture.run(args);

    expect(fixture.setup).not.toHaveBeenCalled();
    expect(mockedEvalDependencies.createDevelopmentServer).not.toHaveBeenCalled();
    expect(mockedEvalDependencies.resolveEvalTargetHandle).not.toHaveBeenCalled();
    expect(fixture.teardown).not.toHaveBeenCalled();
  });

  it("loads local env files before resolving a remote target", async () => {
    const fixtureRoot = await createEnvironmentFixture();
    const resolvedFixtureRoot = await realpath(fixtureRoot);
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const evaluation = {
      _tag: "EveEval" as const,
      id: "demo-eval",
      test: async () => {},
    };

    process.env.EVE_DEV_SHELL_ONLY = "from-shell";
    process.chdir(fixtureRoot);
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([evaluation]);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue(TEST_CONFIG);
    mockedEvalDependencies.resolveEvalTargetHandle.mockImplementation(async () => {
      expect(process.env.EVE_DEV_LOCAL_ONLY).toBe("from-local");
      return {
        attachSession: vi.fn(),
        capabilities: { devRoutes: false },
        dispatchSchedule: vi.fn(),
        fetch: vi.fn(),
        kind: "remote",
        url: "https://example.com",
      };
    });
    mockedEvalDependencies.executeEval.mockResolvedValue(makeEvalResult(evaluation.id));

    try {
      await runCli(["eval", "--url", "https://example.com"], logger);
    } finally {
      process.chdir(previousCwd);
    }

    expect(process.env.EVE_DEV_DEVELOPMENT_LOCAL_ONLY).toBe("from-development-local");
    expect(process.env.EVE_DEV_LOCAL_ONLY).toBe("from-local");
    expect(process.env.EVE_DEV_DEVELOPMENT_ONLY).toBe("from-development");
    expect(process.env.EVE_DEV_DEFAULT_ONLY).toBe("from-env");
    expect(process.env.EVE_DEV_SHARED).toBe("from-local");
    expect(process.env.EVE_DEV_SHELL_ONLY).toBe("from-shell");
    expect(mockedEvalDependencies.discoverAndImportEvals).toHaveBeenCalledWith(
      resolvedFixtureRoot,
      undefined,
    );
    expect(mockedEvalDependencies.resolveEvalTargetHandle).toHaveBeenCalled();
    expect(mockedEvalDependencies.executeEval).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("shuts down tracked sandbox handles after a local eval run", async () => {
    const fixtureRoot = await createEnvironmentFixture();
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const close = vi.fn(async () => {});
    const handle = { onRuntimeShutdown: vi.fn(async () => {}) };
    const evaluation = makeEvaluation("local");

    trackActiveSandboxHandle({ providerName: "microsandbox", handle, sessionId: "session-1" });
    process.chdir(fixtureRoot);
    mockedEvalDependencies.createDevelopmentServer.mockReturnValue({
      close,
      start: vi.fn(async () => ({
        appRoot: fixtureRoot,
        kind: "started" as const,
        url: "http://127.0.0.1:43123",
      })),
    });
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([evaluation]);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue(TEST_CONFIG);
    mockedEvalDependencies.resolveEvalTargetHandle.mockResolvedValue({
      attachSession: vi.fn(),
      capabilities: { devRoutes: true },
      dispatchSchedule: vi.fn(),
      fetch: vi.fn(),
      kind: "local",
      url: "http://127.0.0.1:43123",
    });
    mockedEvalDependencies.executeEval.mockResolvedValue(makeEvalResult(evaluation.id));

    try {
      await runCli(["eval"], logger);
    } finally {
      process.chdir(previousCwd);
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(handle.onRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(process.env.EVE_EVALUATION).toBe("1");
    expect(process.env.EVE_EVALUATION_RUN_ID).toMatch(/^[0-9a-f-]{36}$/u);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("writes all evals to one JUnit file", async () => {
    const fixtureRoot = await createEnvironmentFixture();
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const target = {
      attachSession: vi.fn(),
      capabilities: { devRoutes: false },
      dispatchSchedule: vi.fn(),
      fetch: vi.fn(),
      kind: "remote" as const,
      url: "https://example.com",
    };

    process.chdir(fixtureRoot);
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([
      makeEvaluation("alpha"),
      makeEvaluation("beta"),
    ]);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue(TEST_CONFIG);
    mockedEvalDependencies.resolveEvalTargetHandle.mockResolvedValue(target);
    mockedEvalDependencies.executeEval.mockImplementation(async (input) =>
      makeEvalResult(input.evaluation.id),
    );

    try {
      await runCli(
        [
          "eval",
          "--url",
          "https://example.com",
          "--json",
          "--junit",
          join(fixtureRoot, "junit.xml"),
        ],
        logger,
      );
    } finally {
      process.chdir(previousCwd);
    }

    const xml = await readFile(join(fixtureRoot, "junit.xml"), "utf8");
    expect(xml).toContain('<testsuite name="eve evals" tests="2" failures="1" skipped="0"');
    expect(xml).toContain('name="alpha"');
    expect(xml).toContain('name="beta"');
    expect(xml).toContain('<failure message="check (0% &lt; 100%): nope">');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

async function createEvalSetupFixture() {
  const appRoot = await realpath(await createEnvironmentFixture());
  const logger = { error: vi.fn(), log: vi.fn() };
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const teardown = vi.fn(async () => {});
  const setup = vi.fn(async () => {});
  const start = vi.fn(async () => ({ url: "http://127.0.0.1:43123" }));
  const close = vi.fn(async () => {});
  process.env.EVE_DEV_SHELL_ONLY = "from-shell";
  mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue(
    [makeEvaluation("first"), makeEvaluation("second")].map((evaluation) => ({
      ...evaluation,
      tags: ["setup"],
    })),
  );
  mockedEvalDependencies.discoverEvalConfig.mockResolvedValue({ ...TEST_CONFIG, setup, teardown });
  mockedEvalDependencies.createDevelopmentServer.mockReturnValue({ start, close });
  mockedEvalDependencies.resolveEvalTargetHandle.mockResolvedValue({
    kind: "local",
    url: "http://127.0.0.1:43123",
  });
  mockedEvalDependencies.executeEval.mockImplementation(async ({ evaluation }) => {
    return makeEvalResult(evaluation.id);
  });

  return {
    appRoot,
    logger,
    exit,
    setup,
    start,
    close,
    teardown,
    async run(args: string[] = []) {
      const previousCwd = process.cwd();
      process.chdir(appRoot);
      try {
        await runCli(["eval", "--skip-report", ...args], logger);
      } finally {
        process.chdir(previousCwd);
      }
    },
  };
}

function makeEvaluation(id: string) {
  return {
    _tag: "EveEval" as const,
    id,
    test: async () => {},
  };
}

function makeEvalResult(id: string) {
  const failed = id === "beta";
  return {
    id,
    assertions: [
      failed
        ? { name: "check", score: 0, severity: "gate" as const, passed: false, message: "nope" }
        : { name: "check", score: 1, severity: "gate" as const, passed: true },
    ],
    result: {
      derived: {
        failureCode: undefined,
        inputRequests: [],
        messageCount: 1,
        parked: false,
        reasoningBlockCount: 0,
        subagentCallCount: 0,
        subagentCalls: [],
        toolCallCount: 0,
        toolCalls: [],
      },
      events: [],
      finalMessage: "done",
      output: "done",
      status: "completed",
    },
    verdict: failed ? "failed" : "passed",
    startedAt: "2026-04-08T00:00:00.000Z",
    completedAt: "2026-04-08T00:00:01.000Z",
  };
}
