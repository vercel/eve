import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BENCHMARK_HARNESSES, resolveBenchmarkRequest } from "./resolve-benchmark-request.mjs";

const sha = "a".repeat(40);
const pull = {
  number: 42,
  state: "open",
  head: { sha, repo: { full_name: "vercel/eve", fork: false } },
  base: { repo: { full_name: "vercel/eve" } },
};

function fixture({
  eventName = "issue_comment",
  body = "/benchmark",
  permission = "write",
  pr = pull,
} = {}) {
  const calls = [];
  const context = {
    eventName,
    repo: { owner: "vercel", repo: "eve" },
    sha: "b".repeat(40),
    payload:
      eventName === "issue_comment"
        ? {
            action: "created",
            issue: { number: 42, pull_request: {} },
            comment: { body, user: { login: "alice", type: "User" } },
          }
        : eventName === "pull_request"
          ? { pull_request: pull }
          : { inputs: {} },
  };
  const github = {
    rest: {
      repos: {
        async getCollaboratorPermissionLevel(input) {
          calls.push(["permission", input]);
          return { data: { permission } };
        },
      },
      pulls: {
        async get(input) {
          calls.push(["pull", input]);
          return { data: pr };
        },
      },
    },
  };
  return { context, github, calls };
}

const resolve = (input) => resolveBenchmarkRequest(input);

test("automatic PR runs select only eve-code at the exact current PR head", async () => {
  const input = fixture({ eventName: "pull_request" });
  assert.deepEqual(await resolve(input), { harness: "eve-code", sha, pr: "42" });
  assert.deepEqual(input.calls, [["pull", { owner: "vercel", repo: "eve", pull_number: 42 }]]);
});

test("bare comment command reruns eve-code at the PR head, not default-branch github.sha", async () => {
  const input = fixture();
  assert.deepEqual(await resolve(input), { harness: "eve-code", sha, pr: "42" });
  assert.deepEqual(input.calls[0], [
    "permission",
    { owner: "vercel", repo: "eve", username: "alice" },
  ]);
});

for (const harness of BENCHMARK_HARNESSES) {
  test(`a comment can select ${harness} independently`, async () => {
    assert.deepEqual(await resolve(fixture({ body: `/benchmark ${harness}` })), {
      harness,
      sha,
      pr: "42",
    });
  });
}

for (const permission of ["read", "triage", "none"]) {
  test(`${permission} permission cannot launch a benchmark`, async () => {
    const input = fixture({ permission });
    assert.equal(await resolve(input), null);
    assert.equal(input.calls.length, 1);
  });
}

for (const permission of ["write", "maintain", "admin"]) {
  test(`${permission} permission can request a benchmark`, async () => {
    assert.equal((await resolve(fixture({ permission }))).harness, "eve-code");
  });
}

test("permission lookup errors fail closed", async () => {
  const input = fixture();
  input.github.rest.repos.getCollaboratorPermissionLevel = async () => {
    throw new Error("permission unavailable");
  };
  await assert.rejects(resolve(input), /permission unavailable/u);
  assert.equal(input.calls.length, 0);
});

test("unrelated comments, bots, edited comments and ordinary issues are ignored", async () => {
  for (const change of [
    (payload) => {
      payload.comment.body = "Looks good";
    },
    (payload) => {
      payload.comment.user.type = "Bot";
    },
    (payload) => {
      payload.action = "edited";
    },
    (payload) => {
      delete payload.issue.pull_request;
    },
  ]) {
    const input = fixture();
    change(input.context.payload);
    assert.equal(await resolve(input), null);
    assert.deepEqual(input.calls, []);
  }
});

test("invalid or injected commands never become action inputs", async () => {
  for (const body of [
    "/benchmark missing",
    "/benchmark codex; echo nope",
    "/benchmark codex\necho nope",
    "/benchmark codex extra",
  ]) {
    await assert.rejects(
      resolve(fixture({ body })),
      /Use \/benchmark|Supported benchmark harnesses/u,
    );
  }
});

test("closed, forked and cross-repository PRs are not executed", async () => {
  for (const change of [
    (pr) => {
      pr.state = "closed";
    },
    (pr) => {
      pr.head.repo.fork = true;
    },
    (pr) => {
      pr.head.repo.full_name = "alice/eve";
    },
    (pr) => {
      pr.head.repo = null;
    },
    (pr) => {
      pr.base.repo.full_name = "another/repository";
    },
  ]) {
    const pr = structuredClone(pull);
    change(pr);
    assert.equal(await resolve(fixture({ pr })), null);
  }
});

test("a superseded pull_request event cannot run or cancel the current benchmark", async () => {
  const input = fixture({ eventName: "pull_request" });
  input.context.payload = {
    pull_request: { ...pull, head: { ...pull.head, sha: "c".repeat(40) } },
  };
  assert.equal(await resolve(input), null);
});

test("manual dispatch defaults to eve-code and validates an explicit harness", async () => {
  const input = fixture({ eventName: "workflow_dispatch" });
  assert.deepEqual(await resolve(input), { harness: "eve-code", sha: input.context.sha, pr: "" });
  input.context.payload.inputs.harness = "codex";
  assert.equal((await resolve(input)).harness, "codex");
  input.context.payload.inputs.harness = "missing";
  await assert.rejects(resolve(input), /Supported benchmark harnesses/u);
});

test("workflow names and concurrency preserve independent authorized harness runs", async () => {
  const workflow = await readFile(
    new URL("../workflows/eve-code-benchmark.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^name: eve-code\n/u);
  assert.match(workflow, /name: Benchmark harness/u);
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/u);
  assert.match(
    workflow,
    /needs: request\n\s+if: needs\.request\.outputs\.run == 'true'\n\s+concurrency:/u,
  );
  assert.match(
    workflow,
    /group: eve-code-.*needs\.request\.outputs\.pr.*needs\.request\.outputs\.harness/u,
  );
  assert.match(workflow, /agent-ref: \$\{\{ needs\.request\.outputs\.sha \}\}/u);
});

test("the consumer tracks eve-bench main and owns its model selection", async () => {
  const workflow = await readFile(
    new URL("../workflows/eve-code-benchmark.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /repository: vercel-labs\/eve-bench\n\s+ref: main\n/u);
  assert.match(workflow, /uses: \.\/\.eve-bench-action/u);
  assert.match(
    workflow,
    /model: \$\{\{ vars\.EVE_CODE_BENCH_MODEL \|\| 'google\/gemini-3\.8-flash' \}\}/u,
  );
  assert.doesNotMatch(workflow, /runner-revision:/u);
  assert.match(workflow, /blob-token: \$\{\{ secrets\.EVE_BENCH_BLOB_READ_WRITE_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /artifact-id/u);
  assert.match(workflow, /dataset: swe-lean\n/u);
  assert.doesNotMatch(workflow, /^\s+task:/mu);
  assert.equal((workflow.match(/uses: \.\/\.eve-bench-action/gu) ?? []).length, 1);
});
