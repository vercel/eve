import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./timings.mjs", import.meta.url);

test("reports timing phases and aggregate durations", () => {
  const directory = mkdtempSync(join(tmpdir(), "eve-benchmark-timings-"));
  const path = join(directory, "timings.json");
  try {
    writeFileSync(
      path,
      JSON.stringify([
        { phase: "run.context", durationMs: 0, outcome: "success", details: { cache: "cold" } },
        { phase: "dependency-snapshot.get-or-create", durationMs: 1_000, outcome: "success" },
        { phase: "subject-snapshot.get-or-create", durationMs: 2_000, outcome: "success" },
        { phase: "session.create", durationMs: 6_000, outcome: "success" },
        { phase: "agent.turn.1", durationMs: 3_000, outcome: "success" },
        { phase: "validation.grader", durationMs: 6_000, outcome: "success" },
        { phase: "validation.typecheck", durationMs: 2_000, outcome: "success" },
        { phase: "validation.build", durationMs: 4_000, outcome: "success" },
        { phase: "run.total", durationMs: 13_000, outcome: "success" },
      ]),
    );
    const output = execFileSync(process.execPath, [script.pathname, path], { encoding: "utf8" });
    assert.match(output, /dependency-snapshot\.get-or-create\s+1\.0s\s+success/u);
    assert.match(output, /Setup:\s+6\.0s/u);
    assert.match(output, /Agent:\s+3\.0s/u);
    assert.match(output, /Grader:\s+6\.0s/u);
    assert.match(output, /Checks:\s+4\.0s/u);
    assert.match(output, /Validation:\s+10\.0s/u);
    assert.match(output, /Total:\s+13\.0s/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
