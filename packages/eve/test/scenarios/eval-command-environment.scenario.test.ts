import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const mockedEvalDependencies = vi.hoisted(() => ({
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

vi.mock("../../src/evals/target.js", () => ({
  resolveEvalTargetHandle: mockedEvalDependencies.resolveEvalTargetHandle,
}));

const createScratchDirectory = useTemporaryDirectories();

const DEVELOPMENT_ENV_KEYS = [
  "EVE_DEV_DEFAULT_ONLY",
  "EVE_DEV_DEVELOPMENT_LOCAL_ONLY",
  "EVE_DEV_DEVELOPMENT_ONLY",
  "EVE_DEV_LOCAL_ONLY",
  "EVE_DEV_SHARED",
  "EVE_DEV_SHELL_ONLY",
] as const;

async function createEnvironmentFixture(): Promise<string> {
  const fixtureRoot = await createScratchDirectory("eve-eval-env-");

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

afterEach(() => {
  clearDevelopmentEnvironment();
  process.exitCode = undefined;
  vi.restoreAllMocks();
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
    expect(xml).toContain('<failure message="check: nope">');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

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
