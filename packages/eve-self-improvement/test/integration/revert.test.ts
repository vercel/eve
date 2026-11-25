import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { config, experiment, BASE, HEAD, MERGED } from "./fixtures.js";
import { digest } from "../../extension/lib/config.js";
import { GitHub } from "../../extension/lib/providers.js";

const changes = { additions: [{ path: "agent/tool.ts", contents: "cmVzdG9yZWQ=" }], deletions: [] };
const branch = "eve-evolve/revert-fixture";
const operation = digest(["revert", "fixture", MERGED, changes]);
const sandbox = {
  async run({ command }: { command: string }) {
    return { exitCode: 0, stdout: command.includes("--name-only") ? "agent/tool.ts\0" : "" };
  },
  async delete() {},
};
mock.module("../../extension/lib/hosted.js", {
  exports: {
    checkout: async () => {},
    openIndependent: async () => sandbox,
    repositoryPath: "/workspace/repository",
  },
});
mock.module("../../extension/lib/publish.js", { exports: { captureFiles: async () => changes } });
const { createRevert } = await import("../../extension/lib/revert.js");

test("existing recovery PRs must contain the exact signed reverse tree", async (t) => {
  t.mock.method(GitHub.prototype, "findPr", async () => ({
    number: 1,
    html_url: "https://github.com/fixture/agent/pull/1",
    head: { sha: HEAD, ref: branch, repo: { full_name: "fixture/agent" } },
    base: { sha: MERGED, ref: "main" },
  }));
  t.mock.method(GitHub.prototype, "main", async () => MERGED);
  t.mock.method(GitHub.prototype, "branch", async () => HEAD);
  let tree = "unrelated-tree";
  t.mock.method(GitHub.prototype, "api", async (path: string, method = "GET") => {
    assert.equal(method, "GET", "Recovery must not republish an existing PR");
    if (path.endsWith(MERGED)) return { parents: [{ sha: BASE }] };
    if (path.endsWith(BASE)) return { commit: { tree: { sha: "baseline-tree" } } };
    assert.ok(path.endsWith(HEAD));
    return {
      parents: [{ sha: MERGED }],
      commit: {
        tree: { sha: tree },
        verification: { verified: true },
        message: `Revert\n\nEve-Evolution-Operation: ${operation}`,
      },
    };
  });
  const e = { ...experiment(), release: { sha: MERGED } } as Parameters<typeof createRevert>[1];
  await assert.rejects(createRevert(config(), e), /signature or operation identity/);
  tree = "baseline-tree";
  const adopted = await createRevert(config(), e);
  assert.equal(adopted.head, HEAD);
  assert.deepEqual(adopted.changedPaths, ["agent/tool.ts"]);
});
