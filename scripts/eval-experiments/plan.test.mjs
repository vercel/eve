import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlan } from "./plan.mjs";

test("rejects out-of-range repetition budgets before checking repositories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eve-experiment-plan-"));
  try {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const manifestDir = join(root, "experiments");
    const committedManifest = join(manifestDir, "eval-experiments-plan-test.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(manifestDir, { recursive: true }));
    await writeFile(
      committedManifest,
      JSON.stringify({
        version: 1,
        baseline: { label: "baseline", sha: "a".repeat(40) },
        candidates: [{ label: "candidate", sha: "b".repeat(40) }],
        fixtures: [
          {
            name: "agent-self-modification",
            evals: ["self-modification/create-shipping-quote"],
            metrics: "self-modification-v1",
          },
        ],
        models: ["openai-sol"],
        repetitions: 31,
        seed: 42,
        maxConcurrency: 1,
      }),
    );
    await assert.rejects(
      createPlan(committedManifest),
      /repetitions must be an integer from 1 to 30/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(
      join(
        fileURLToPath(new URL("../..", import.meta.url)),
        "experiments/eval-experiments-plan-test.json",
      ),
      { force: true },
    );
  }
});
