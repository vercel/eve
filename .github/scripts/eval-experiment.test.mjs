import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../workflows/eval-experiment.yml", import.meta.url),
  "utf8",
);

test("PR experiments are opt-in, same-repository, and available to drafts", () => {
  assert.match(workflow, /pull_request:\n\s+types: \[labeled\]/u);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' \|\|/u);
  assert.match(
    workflow,
    /\(github\.event_name == 'pull_request' &&\s+github\.event\.label\.name == 'run-eval-experiment' &&\s+github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)/u,
  );
  assert.doesNotMatch(workflow, /pull_request_target:|issue_comment:|\.draft/u);
  assert.match(workflow, /persist-credentials: false/u);
});

test("checkout and analysis use the same immutable experiment revision", () => {
  assert.match(
    workflow,
    /EXPERIMENT_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
  );
  assert.match(workflow, /ref: \$\{\{ env\.EXPERIMENT_SHA \}\}/u);
  assert.match(
    workflow,
    /extract\.mjs execution plan\.json samples\.json "\$DEFINITION" "\$EXPERIMENT_SHA"/u,
  );
  assert.doesNotMatch(workflow, /\$\{GITHUB_SHA\}/u);
});

test("PR runs select the example definition while dispatch accepts an input", () => {
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+definition:/u);
  assert.match(
    workflow,
    /DEFINITION: \$\{\{ inputs\.definition \|\| 'experiments\/self-modification\.mjs' \}\}/u,
  );
  assert.equal((workflow.match(/DEFINITION:/gu) ?? []).length, 1);
  assert.match(workflow, /plan\.mjs "\$DEFINITION" plan\.json/u);
});
