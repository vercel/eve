import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchedule } from "./run.mjs";

test("runs each scheduled attempt sequentially and records failed evals without aborting", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-experiment-run-"));
  try {
    const checkouts = {};
    for (const label of ["baseline", "candidate"]) {
      const checkout = join(root, label);
      checkouts[label] = checkout;
      const app = join(checkout, "e2e/fixtures/sample");
      await mkdir(join(app, "agent"), { recursive: true });
      await mkdir(join(app, "node_modules/.bin"), { recursive: true });
      await writeFile(join(app, "agent/agent.ts"), "export const value = 1;\n");
      if (label === "candidate") await writeFile(join(app, "agent/fail"), "yes\n");
      await writeFile(
        join(app, "node_modules/.bin/pnpm"),
        '#!/bin/sh\nif [ "$1" = "run" ]; then exit 0; fi\nmkdir -p .eve/evals/2026-01-01/evals\nprintf \'{\\"id\\":\\"case\\",\\"verdict\\":\\"passed\\",\\"result\\":{\\"sessions\\":[]}}\' > .eve/evals/2026-01-01/evals/case.json\nif [ -f agent/fail ]; then exit 1; fi\nexit 0\n',
      );
      await import("node:fs/promises").then(({ chmod }) =>
        chmod(join(app, "node_modules/.bin/pnpm"), 0o755),
      );
    }
    const outputDir = join(root, "output");
    const plan = {
      variants: [
        { label: "baseline", sha: "a" },
        { label: "candidate", sha: "b" },
      ],
      metricProfiles: [
        {
          id: "self-modification-v1",
          metricSchemaVersion: "self-modification-v1",
          primaryMetric: "creationElapsedMs",
        },
      ],
      fixtures: [{ name: "sample", metricProfile: "self-modification-v1", evals: ["case"] }],
    };
    const schedule = {
      fixture: "sample",
      model: "mock",
      modelId: "mock",
      blocks: [{ repetition: 0, order: ["baseline", "candidate"] }],
    };
    const records = await runSchedule({
      plan,
      schedule,
      checkouts,
      outputDir,
      env: {
        ...process.env,
        PATH: `${join(root, "baseline/e2e/fixtures/sample/node_modules/.bin")}:${process.env.PATH}`,
      },
      timeoutMs: 5000,
    });
    assert.equal(records.length, 2);
    assert.equal(records[0].correctnessOutcome, "passed");
    assert.equal(records[1].correctnessOutcome, "failed");
    assert.equal(JSON.parse(await readFile(join(outputDir, "invocations.json"), "utf8")).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
