import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(output.suite.caseCount, 3);
    assert.match(output.suite.caseFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(output.results.length, 6);
    assert.ok(output.results.every((result) => result.status === "missing"));
    for (const privateField of ["transcript", "commands", "worldEvents", "files"]) {
      assert.equal(raw.includes(`\"${privateField}\"`), false);
    }
  } finally {
    rmSync(resultsPath, { recursive: true, force: true });
    if (existsSync(savedResultsPath)) renameSync(savedResultsPath, resultsPath);
    rmSync(directory, { recursive: true, force: true });
  }
});
