import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEvalCommand } from "#evals/cli/eval.js";
import type { EveEval } from "#evals/types.js";

vi.mock("#internal/application/paths.js", () => ({
  resolveApplicationRoot: vi.fn(() => "/app"),
}));
vi.mock("#cli/dev/environment.js", () => ({
  loadDevelopmentEnvironmentFiles: vi.fn(),
}));
vi.mock("#evals/runner/discover.js", () => ({
  discoverAndImportEvals: vi.fn(async () => []),
  discoverEvalConfig: vi.fn(async () => ({})),
  findMisplacedEvalDirs: vi.fn(async () => []),
}));

vi.mock("#internal/nitro/host.js", () => ({
  createDevelopmentServer: vi.fn(() => ({
    close: vi.fn(async () => {}),
    start: vi.fn(async () => ({ url: "http://127.0.0.1:4000" })),
  })),
}));
vi.mock("#evals/cli/eval-client.js", () => ({ createEvalClient: vi.fn(async () => ({})) }));
vi.mock("#evals/target.js", () => ({ resolveEvalTargetHandle: vi.fn(async () => ({})) }));
vi.mock("#evals/runner/run-evals.js", () => ({
  runEvals: vi.fn(async () => ({ failed: 0, scored: 0 })),
}));
vi.mock("#evals/cli/eval-state-directory.js", () => ({
  createEvalStateDirectory: vi.fn(async () => "/app/.eve/eval-servers/run_1"),
  removeEvalStateDirectory: vi.fn(async () => {}),
}));
vi.mock("#execution/sandbox/active-connections.js", () => ({
  shutdownActiveSandboxConnections: vi.fn(async () => {}),
}));

const { discoverAndImportEvals } = vi.mocked(await import("#evals/runner/discover.js"), {
  partial: true,
});
const { removeEvalStateDirectory } = vi.mocked(await import("#evals/cli/eval-state-directory.js"));

function createEval(id: string, tags?: readonly string[]): EveEval {
  return { _tag: "EveEval", id, tags, test: async () => {} };
}

function createLogger() {
  return { error: vi.fn(), log: vi.fn() };
}

describe("runEvalCommand list mode", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it("lists an empty JSON array when exclusion removes every eval", async () => {
    discoverAndImportEvals.mockResolvedValueOnce([createEval("cancel", ["real-model"])]);
    const logger = createLogger();

    await runEvalCommand([], { excludeTag: ["real-model"], json: true, list: true }, logger);

    expect(process.exitCode).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.log.mock.calls[0]![0] as string)).toEqual([]);
  });

  it("lists only the evals that survive exclusion", async () => {
    discoverAndImportEvals.mockResolvedValueOnce([
      createEval("judged", ["real-model"]),
      createEval("mock-capable"),
    ]);
    const logger = createLogger();

    await runEvalCommand([], { excludeTag: ["real-model"], json: true, list: true }, logger);

    expect(process.exitCode).toBeUndefined();
    const listing = JSON.parse(logger.log.mock.calls[0]![0] as string) as { id: string }[];
    expect(listing.map((entry) => entry.id)).toEqual(["mock-capable"]);
  });

  it("still succeeds with the exclusion notice on a non-list run", async () => {
    discoverAndImportEvals.mockResolvedValueOnce([createEval("cancel", ["real-model"])]);
    const logger = createLogger();

    await runEvalCommand([], { excludeTag: ["real-model"] }, logger);

    expect(process.exitCode).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "All 1 matching evals are excluded by tags (real-model); nothing to run.",
    );
  });

  it("keeps exit 2 when an include tag matches nothing, even in list mode", async () => {
    discoverAndImportEvals.mockResolvedValueOnce([createEval("mock-capable")]);
    const logger = createLogger();

    await runEvalCommand([], { json: true, list: true, tag: ["nonexistent"] }, logger);

    expect(process.exitCode).toBe(2);
    expect(logger.error).toHaveBeenCalledWith("No evals matched the provided tags (nonexistent).");
  });
});

describe("runEvalCommand local server state", () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    discoverAndImportEvals.mockResolvedValueOnce([createEval("weather")]);
  });

  afterEach(() => {
    process.env = { ...env };
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("removes the eval server's state when the run ends", async () => {
    await runEvalCommand([], {}, createLogger(), "/app");

    expect(removeEvalStateDirectory).toHaveBeenCalledWith("/app/.eve/eval-servers/run_1");
  });

  it("keeps the eval server's state with --keep-state and says where", async () => {
    const logger = createLogger();

    await runEvalCommand([], { keepState: true }, logger, "/app");

    expect(removeEvalStateDirectory).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Kept the eval server's state in .eve/eval-servers/run_1.",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("warns that --keep-state does nothing against a remote server", async () => {
    const logger = createLogger();

    await runEvalCommand([], { keepState: true, url: "https://agent.example" }, logger, "/app");

    expect(logger.error).toHaveBeenCalledWith(
      "--keep-state has no effect with --url: the remote server keeps its own state.",
    );
    expect(removeEvalStateDirectory).not.toHaveBeenCalled();
  });
});
