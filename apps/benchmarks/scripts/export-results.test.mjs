import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

const appRoot = new URL("..", import.meta.url);

test("exports missing cells without publishing private artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "eve-benchmark-export-"));
  const outputPath = join(directory, "results.json");
  const resultsPath = new URL("../results", import.meta.url).pathname;
  const savedResultsPath = join(directory, "saved-results");
  try {
    if (existsSync(resultsPath)) renameSync(resultsPath, savedResultsPath);
    mkdirSync(resultsPath, { recursive: true });
    execFileSync(
      process.execPath,
      [
        new URL("./export-results.mjs", import.meta.url).pathname,
        "--revision",
        "a".repeat(40),
        "--output",
        outputPath,
      ],
      { cwd: appRoot, stdio: "pipe" },
    );
    const raw = readFileSync(outputPath, "utf8");
    const output = JSON.parse(raw);

    assert.equal(output.schemaVersion, 1);
    assert.equal(output.suite.caseCount, 2);
    assert.match(output.suite.caseFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(output.experiments.length, 12);
    assert.deepEqual(
      [...new Set(output.experiments.map((experiment) => experiment.modelDisplayName))],
      [
        "Claude Sonnet 4.6",
        "Kimi K3",
        "Claude Fable 5",
        "GPT-5.6 Sol",
        "GPT-5.6 Terra",
        "Gemini 3.1 Pro Preview",
      ],
    );
    assert.equal(output.results.length, 24);
    assert.ok(output.results.every((result) => result.status === "missing"));
    for (const privateField of ["transcript", "commands", "worldEvents", "files"]) {
      assert.equal(raw.includes(`"${privateField}"`), false);
    }
  } finally {
    rmSync(resultsPath, { recursive: true, force: true });
    if (existsSync(savedResultsPath)) renameSync(savedResultsPath, resultsPath);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exports the mean estimated list cost from run token usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "eve-benchmark-export-cost-"));
  const outputPath = join(directory, "results.json");
  const resultsPath = new URL("../results", import.meta.url).pathname;
  const savedResultsPath = join(directory, "saved-results");
  try {
    if (existsSync(resultsPath)) renameSync(resultsPath, savedResultsPath);
    const runPath = join(
      resultsPath,
      "claude-sonnet-4-6-opencode--baseline",
      "run",
      "author-001-weather-tool",
      "run-1",
    );
    mkdirSync(runPath, { recursive: true });
    writeFileSync(
      join(runPath, "transcript-raw.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      })}\n`,
    );
    writeFileSync(
      join(dirname(runPath), "summary.json"),
      JSON.stringify({ totalRuns: 1, passedRuns: 1, meanDuration: 1 }),
    );
    execFileSync(
      process.execPath,
      [
        new URL("./export-results.mjs", import.meta.url).pathname,
        "--revision",
        "a".repeat(40),
        "--models",
        "claude-sonnet-4-6",
        "--output",
        outputPath,
      ],
      { cwd: appRoot, stdio: "pipe" },
    );
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    const result = output.results.find(
      (entry) =>
        entry.experimentId === "claude-sonnet-4-6-opencode--baseline" &&
        entry.caseId === "author-001-weather-tool",
    );
    assert.equal(result.meanEstimatedListCostUsd, 4.5);
  } finally {
    rmSync(resultsPath, { recursive: true, force: true });
    if (existsSync(savedResultsPath)) renameSync(savedResultsPath, resultsPath);
    rmSync(directory, { recursive: true, force: true });
  }
});
