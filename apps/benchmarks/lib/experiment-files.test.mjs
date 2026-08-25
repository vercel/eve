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
  writeSubjectArchives,
} from "./experiment-files.mjs";

const subject = {
  archive: Buffer.from("source"),
  dependencyArchive: Buffer.from("dependencies"),
  digest: "source-digest",
  dependencyDigest: "dependency-digest",
};
const benchmark = {
  id: "test",
  model: "test/model",
  displayName: "Test",
  harness: "OpenCode",
  support: "supported",
};

test("materializes fixtures and complete experiment inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-experiments-"));
  const evals = join(root, "evals");
  const experiments = join(root, "experiments");
  try {
    writeCase(evals, "author-002-second");
    writeCase(evals, "author-001-first");
    writeFileSync(join(evals, "not-a-case"), "ignored");
    assert.deepEqual(fixtureNames(evals), ["author-001-first", "author-002-second"]);

    prepareFixtures(evals);
    assert.equal(readFileSync(join(evals, "author-001-first", "PROMPT.md"), "utf8"), "");
    assert.deepEqual(JSON.parse(readFileSync(join(evals, "author-001-first", "package.json"))), {
      name: "eve-authoring-author-001-first",
      private: true,
      type: "module",
    });

    resetExperiments(experiments);
    const archives = writeSubjectArchives(experiments, subject, "published-deadbeef");
    writeExperiment(experiments, "test-opencode--guided", {
      ...archives,
      digest: subject.digest,
      dependencyDigest: subject.dependencyDigest,
      runs: 3,
      evals: ["author-001-first"],
      benchmark,
      treatment: "guided",
    });

    assert.equal(readFileSync(join(experiments, archives.archiveName), "utf8"), "source");
    assert.equal(
      readFileSync(join(experiments, archives.dependencyArchiveName), "utf8"),
      "dependencies",
    );
    const experiment = readFileSync(join(experiments, "test-opencode--guided.ts"), "utf8");
    assert.match(experiment, /dependencyArchive: readFileSync/u);
    assert.match(experiment, /published-deadbeef\.dependencies\.tar\.gz/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeCase(evals, name) {
  const root = join(evals, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "CASE.ts"), "export default {};\n");
  assert.ok(existsSync(root));
}
