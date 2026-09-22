import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  fixtureNames,
  prepareFixtures,
  resetExperiments,
  writeExperiment,
} from "./experiment-files.mjs";

const subject = {
  revision: "1234567890abcdef1234567890abcdef12345678",
  packageSpec: "https://pkg.eve.dev/1234567890abcdef1234567890abcdef12345678/eve.tgz",
};
const benchmark = {
  id: "test",
  model: "test/model",
  displayName: "Test",
  harness: "OpenCode",
  support: "supported",
};

test("materializes fixtures and complete experiment inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-experiments-"));
  const evals = join(root, "evals");
  const experiments = join(root, "experiments");
  try {
    writeCase(evals, "author-002-second");
    writeCase(evals, "author-001-first");
    writeFileSync(join(evals, "not-a-case"), "ignored");
    assert.deepEqual(fixtureNames(evals), ["author-001-first", "author-002-second"]);

    await prepareFixtures(evals, subject);
    assert.equal(readFileSync(join(evals, "author-001-first", "PROMPT.md"), "utf8"), "Build it.\n");
    assert.deepEqual(
      JSON.parse(readFileSync(join(evals, "author-001-first", ".eve-authoring-bootstrap.json"))),
      { startingPoint: "scaffolded", revision: subject.revision, setupIds: [] },
    );
    assert.deepEqual(JSON.parse(readFileSync(join(evals, "author-001-first", "package.json"))), {
      name: "eve-authoring-author-001-first",
      private: true,
      type: "module",
    });

    resetExperiments(experiments);
    writeExperiment(experiments, "test-opencode--guided", {
      revision: subject.revision,
      packageSpec: subject.packageSpec,
      runs: 3,
      evals: ["author-001-first"],
      benchmark,
      treatment: "guided",
    });

    const experiment = readFileSync(join(experiments, "test-opencode--guided.ts"), "utf8");
    assert.match(experiment, /revision: "1234567890abcdef1234567890abcdef12345678"/u);
    assert.match(experiment, /pkg\.eve\.dev\/1234567890abcdef1234567890abcdef12345678\/eve\.tgz/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeCase(evals, name) {
  const root = join(evals, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "CASE.ts"),
    'export default { startingPoint: { workspace: "scaffolded" }, async interact({ send }) { await send("Build it."); } };\n',
  );
  assert.ok(existsSync(root));
}
