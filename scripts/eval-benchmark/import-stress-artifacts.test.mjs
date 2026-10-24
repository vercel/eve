import test from "node:test";
import assert from "node:assert/strict";
import { selectReleaseBuilds } from "./import-stress-artifacts.mjs";

const archive = (runId, attempt, headSha, createdAt) => ({
  workflow_run: { id: runId, attempt, head_sha: headSha },
  artifact: { created_at: createdAt },
});
test("keeps only the final head of each merged release PR, latest attempt first", () => {
  const builds = selectReleaseBuilds(
    [
      // An earlier push of the same release PR: same version, different code.
      archive(1, 1, "earlier", "2026-10-01T01:00:00Z"),
      archive(2, 1, "final", "2026-10-01T02:00:00Z"),
      archive(2, 2, "final", "2026-10-01T03:00:00Z"),
      // A release PR that closed without merging published nothing.
      archive(3, 1, "abandoned", "2026-10-01T04:00:00Z"),
    ],
    new Map([["final", { number: 10, merge_commit_sha: "merge-10" }]]),
  );
  assert.deepEqual(
    builds.map(({ metadata, pull }) => [
      pull.number,
      metadata.workflow_run.id,
      metadata.workflow_run.attempt,
    ]),
    [[10, 2, 2]],
  );
});
