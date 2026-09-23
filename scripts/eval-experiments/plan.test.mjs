import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan } from "./plan.mjs";

test("rejects out-of-range repetition budgets before checking repositories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eve-experiment-plan-"));
  const root = directory;
  const manifestDir = join(root, "experiments");
  await mkdir(join(root, "e2e"), { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  try {
    const committedManifest = join(manifestDir, "manifest.json");
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
      createPlan(committedManifest, { root }),
      /repetitions must be an integer from 1 to 30/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
