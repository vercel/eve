import test from "node:test";
import assert from "node:assert/strict";
import { selectReleaseBuilds } from "./import-stress-artifacts.mjs";

const archive = (runId, attempt, headSha, createdAt) => ({
  workflow_run: { id: runId, attempt, head_sha: headSha },
  artifact: { created_at: createdAt },
});
test("keeps the latest attempt on each merged release PR's final head, oldest release first", () => {
  const builds = selectReleaseBuilds(
    [
      archive(4, 1, "next", "2026-10-02T01:00:00Z"),
      // An attempt the mirror could not read is never chosen.
      archive(4, null, "next", "2026-10-02T02:00:00Z"),
      // An earlier push of the same release PR: same version, different code.
      archive(1, 1, "earlier", "2026-10-01T01:00:00Z"),
      archive(2, 1, "final", "2026-10-01T02:00:00Z"),
      archive(2, 2, "final", "2026-10-01T03:00:00Z"),
      // A release PR that closed without merging published nothing.
      archive(3, 1, "abandoned", "2026-10-01T04:00:00Z"),
    ],
    new Map([
      ["final", { number: 10, merge_commit_sha: "merge-10" }],
      ["next", { number: 11, merge_commit_sha: "merge-11" }],
    ]),
  );
  assert.deepEqual(
    builds.map(({ metadata, pull }) => [
      pull.number,
      metadata.workflow_run.id,
      metadata.workflow_run.attempt,
    ]),
    [
      [10, 2, 2],
      [11, 4, 1],
    ],
  );
});
