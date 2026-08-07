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

const { discoverAndImportEvals } = vi.mocked(await import("#evals/runner/discover.js"), {
  partial: true,
});

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
