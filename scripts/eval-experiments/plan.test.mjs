import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan } from "./plan.mjs";

test("validates the experiment-specific model aliases and xhigh configuration", async () => {
  const { default: profile } = await import("./profiles/self-modification-v1.mjs");
  assert.deepEqual(profile.resolveModel("grok-4.7"), {
    id: "spacexai/grok-4.7",
    label: "grok-4.7",
  });
  assert.deepEqual(profile.resolveModel("luna-fast-xhigh"), {
    id: "openai/gpt-5.6-luna-fast",
    reasoning: "xhigh",
    label: "luna-fast-xhigh",
  });
  assert.equal(profile.resolveModel("anthropic-opus").id, "anthropic/claude-opus-5.5");
});

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
        models: ["grok-4.7"],
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
