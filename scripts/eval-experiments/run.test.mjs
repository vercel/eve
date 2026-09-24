import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSchedule } from "./run.mjs";

test("runs scheduled source/configuration cells and records eval exit outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-experiment-run-"));
  try {
    const checkouts = {};
    for (const label of ["base", "candidate"]) {
      const checkout = join(root, label);
      checkouts[label] = checkout;
      const app = join(checkout, "e2e/fixtures/agent-self-modification");
      await mkdir(join(app, "agent"), { recursive: true });
      await mkdir(join(app, "scripts"), { recursive: true });
      await mkdir(join(app, "node_modules/.bin"), { recursive: true });
      await writeFile(
        join(app, "agent/agent.ts"),
        "EVE_EXPERIMENT_PARENT_MODEL EVE_EXPERIMENT_PARENT_REASONING\n",
      );
      await writeFile(
        join(app, "scripts/prepare.mjs"),
        "EVE_EXPERIMENT_SELF_MODIFICATION_MODEL EVE_EXPERIMENT_SELF_MODIFICATION_REASONING\n",
      );
      await writeFile(
        join(app, "node_modules/.bin/pnpm"),
        '#!/bin/sh\nif [ "$1" = "run" ]; then exit 0; fi\nmkdir -p .eve/evals/2026-01-01/evals\nprintf \'{\\"id\\":\\"case\\",\\"verdict\\":\\"passed\\",\\"result\\":{\\"status\\":\\"completed\\",\\"sessions\\":[]}}\' > .eve/evals/2026-01-01/evals/case.json\nexit 0\n',
      );
      await import("node:fs/promises").then(({ chmod }) =>
        chmod(join(app, "node_modules/.bin/pnpm"), 0o755),
      );
    }
    const plan = {
      planHash: "hash",
      experimentRevision: "rev",
      sources: [
        { label: "base", sha: "a" },
        { label: "candidate", sha: "b" },
      ],
      configurations: [{ label: "config", settings: { parent: { model: "provider/model" } } }],
      fixtures: [{ name: "agent-self-modification", evals: ["case"] }],
      schedule: [
        {
          source: "base",
          configuration: "config",
          fixture: "agent-self-modification",
          eval: "case",
          repetition: 0,
          executionOrder: 0,
        },
      ],
    };
    const outputDir = join(root, "output");
    const records = await runSchedule({
      plan,
      checkouts,
      outputDir,
      env: {
        PATH: `${join(root, "base/e2e/fixtures/agent-self-modification/node_modules/.bin")}:${process.env.PATH}`,
        EVE_EXPERIMENT_PARENT_MODEL: "leak",
      },
    });
    assert.equal(records[0].correctnessOutcome, "passed");
    assert.equal(records[0].requestedSettings.parent.model, "provider/model");
    assert.equal(records[0].scheduleIdentity.case.source, "base");
    assert.deepEqual(
      JSON.parse(await readFile(join(outputDir, records[0].artifact, "evals/case.json"), "utf8"))
        .id,
      "case",
    );
    assert.equal(JSON.parse(await readFile(join(outputDir, "invocations.json"), "utf8")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
