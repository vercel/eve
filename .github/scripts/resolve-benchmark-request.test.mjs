import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BENCHMARK_DATASETS,
  BENCHMARK_HARNESSES,
  BENCHMARK_MODEL_FAMILIES,
  DEFAULT_DATASET,
  DEFAULT_HARNESSES,
  DEFAULT_MODEL_FAMILY,
  resolveBenchmarkRequest,
} from "./resolve-benchmark-request.mjs";

const models = { anthropic: "anthropic/claude-sonnet-5.5", openai: "openai/gpt-6.1-sol" };
const anthropic = { family: "anthropic", model: models.anthropic };
const openai = { family: "openai", model: models.openai };
const sweLean = { dataset: "swe-lean", reasoning: "low", attempts: "5" };
const deepsweLean = { dataset: "deepswe-lean", reasoning: "high", attempts: "3" };
const defaults = {
  harness: "eve-code,opencode,pi",
  slug: "eve-code+opencode+pi",
  agentSource: true,
  ...sweLean,
  models: [anthropic],
};
const workflow = () =>
  readFile(new URL("../workflows/eve-code-benchmark.yml", import.meta.url), "utf8");

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
  return { context, github, calls, models };
}

const resolve = (input) => resolveBenchmarkRequest(input);

test("automatic PR runs compare eve-code with opencode and pi at the exact current PR head", async () => {
  assert.deepEqual(DEFAULT_HARNESSES, ["eve-code", "opencode", "pi"]);
  assert.equal(DEFAULT_MODEL_FAMILY, "anthropic");
  const input = fixture({ eventName: "pull_request" });
  assert.deepEqual(await resolve(input), { ...defaults, sha, pr: "42" });
  assert.deepEqual(input.calls, [["pull", { owner: "vercel", repo: "eve", pull_number: 42 }]]);
});

test("bare comment command reruns the default harnesses at the PR head, not default-branch github.sha", async () => {
  const input = fixture();
  assert.deepEqual(await resolve(input), { ...defaults, sha, pr: "42" });
  assert.deepEqual(input.calls[0], [
    "permission",
    { owner: "vercel", repo: "eve", username: "alice" },
  ]);
});

for (const harness of BENCHMARK_HARNESSES) {
  test(`a comment can select ${harness} independently`, async () => {
    assert.deepEqual(await resolve(fixture({ body: `/benchmark ${harness}` })), {
      harness,
      slug: harness,
      agentSource: harness === "eve-code",
      ...sweLean,
      models: [anthropic],
      sha,
      pr: "42",
    });
  });
}

test("a comment can select several harnesses, comma- or space-separated, deduplicated in order", async () => {
  for (const body of [
    "/benchmark pi,eve-code",
    "/benchmark pi eve-code",
    "/benchmark pi, eve-code,pi",
  ]) {
    const result = await resolve(fixture({ body }));
    assert.equal(result.harness, "pi,eve-code");
    assert.equal(result.slug, "pi+eve-code");
  }
});

function dispatchInput(source, name) {
  const input = new RegExp(`\\n {6}${name}:\\n(?: {8}.*\\n)+`, "u").exec(source)?.[0] ?? "";
  return {
    options: /^ {8}options: \[(.*)\]$/mu.exec(input)?.[1].split(/, */u),
    default: /^ {8}default: (\S+)$/mu.exec(input)?.[1],
  };
}

test("manual dispatch offers exactly the datasets and models the resolver accepts", async () => {
  const source = await workflow();
  assert.deepEqual(dispatchInput(source, "dataset"), {
    options: Object.keys(BENCHMARK_DATASETS),
    default: DEFAULT_DATASET,
  });
  assert.deepEqual(dispatchInput(source, "model"), {
    options: ["all", ...BENCHMARK_MODEL_FAMILIES],
    default: "all",
  });
});

test("a comment can select a dataset, with the default harnesses or its own list", async () => {
  assert.deepEqual(await resolve(fixture({ body: "/benchmark deepswe-lean" })), {
    ...defaults,
    ...deepsweLean,
    sha,
    pr: "42",
  });
  for (const body of [
    "/benchmark deepswe-lean eve-code,pi",
    "/benchmark eve-code pi deepswe-lean",
    "/benchmark eve-code, deepswe-lean, pi",
  ]) {
    const result = await resolve(fixture({ body }));
    assert.deepEqual(
      [result.dataset, result.reasoning, result.attempts, result.harness, result.slug],
      ["deepswe-lean", "high", "3", "eve-code,pi", "eve-code+pi"],
    );
  }
  assert.equal((await resolve(fixture({ body: "/benchmark swe-lean pi" }))).dataset, "swe-lean");
});

test("a comment cannot name two datasets", async () => {
  await assert.rejects(
    resolve(fixture({ body: "/benchmark swe-lean deepswe-lean" })),
    /at most one benchmark dataset/u,
  );
});

test("a comment can run one other model family, anywhere in the command", async () => {
  assert.deepEqual(await resolve(fixture({ body: "/benchmark model=openai" })), {
    ...defaults,
    models: [openai],
    sha,
    pr: "42",
  });
  for (const body of [
    "/benchmark deepswe-lean model=openai pi",
    "/benchmark pi, model=openai, deepswe-lean",
  ]) {
    const result = await resolve(fixture({ body }));
    assert.deepEqual(
      [result.dataset, result.harness, result.models],
      ["deepswe-lean", "pi", [openai]],
    );
  }
});

test("a comment runs exactly one model family, since both would share one PR comment", async () => {
  for (const body of [
    "/benchmark model=anthropic,openai",
    "/benchmark model=openai model=anthropic",
    "/benchmark model=all",
    "/benchmark model=gemini",
    "/benchmark model=",
    "/benchmark openai",
  ]) {
    await assert.rejects(resolve(fixture({ body })), {
      message: "A comment runs one model family: name one of model=anthropic, model=openai.",
    });
  }
});

for (const permission of ["read", "triage", "none"]) {
  test(`${permission} permission cannot launch a benchmark`, async () => {
    const input = fixture({ permission });
    assert.equal(await resolve(input), null);
    assert.equal(input.calls.length, 1);
  });
}

for (const permission of ["write", "maintain", "admin"]) {
  test(`${permission} permission can request a benchmark`, async () => {
    assert.equal((await resolve(fixture({ permission }))).harness, defaults.harness);
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
  const usage = /^Use \/benchmark \[<dataset>\] \[model=<family>\]/u;
  const harnesses = /^Supported benchmark harnesses: /u;
  for (const [body, message] of [
    ["/benchmark missing", harnesses],
    ["/benchmark codex; echo nope", usage],
    ["/benchmark codex\necho nope", usage],
    ["/benchmark codex extra", harnesses],
    ["/benchmark codex,", usage],
    ["/benchmark codex;pi", usage],
    ["/benchmark harness=pi", harnesses],
  ]) {
    await assert.rejects(resolve(fixture({ body })), { message }, body);
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

test("manual dispatch defaults to the default harnesses and validates an explicit list", async () => {
  const input = fixture({ eventName: "workflow_dispatch" });
  assert.deepEqual(await resolve(input), {
    ...defaults,
    models: [anthropic, openai],
    sha: input.context.sha,
    pr: "",
  });
  input.context.payload.inputs.harness = "codex";
  assert.equal((await resolve(input)).harness, "codex");
  input.context.payload.inputs.harness = "codex, pi";
  assert.equal((await resolve(input)).harness, "codex,pi");
  input.context.payload.inputs.harness = "missing";
  await assert.rejects(resolve(input), /Supported benchmark harnesses/u);
});

test("manual dispatch can publish a deepswe-lean result and rejects unknown datasets", async () => {
  const input = fixture({ eventName: "workflow_dispatch" });
  input.context.payload.inputs = { harness: "", dataset: "deepswe-lean" };
  assert.deepEqual(await resolve(input), {
    ...defaults,
    ...deepsweLean,
    models: [anthropic, openai],
    sha: input.context.sha,
    pr: "",
  });
  input.context.payload.inputs.dataset = "terminal-bench";
  await assert.rejects(resolve(input), /Supported benchmark datasets: swe-lean, deepswe-lean/u);
});

test("only a run with eve-code passes the agent source, which eve-bench rejects otherwise", async () => {
  const input = fixture({ eventName: "workflow_dispatch" });
  input.context.payload.inputs = { harness: "opencode", dataset: "deepswe-lean" };
  assert.equal((await resolve(input)).agentSource, false);
  input.context.payload.inputs.harness = "opencode,eve-code";
  assert.equal((await resolve(input)).agentSource, true);
});

test("manual dispatch can select one model family or all of them", async () => {
  const input = fixture({ eventName: "workflow_dispatch" });
  for (const [model, expected] of [
    ["all", [anthropic, openai]],
    ["openai", [openai]],
  ]) {
    input.context.payload.inputs = { model };
    assert.deepEqual((await resolve(input)).models, expected);
  }
  input.context.payload.inputs = { model: "gemini" };
  await assert.rejects(resolve(input), /Supported benchmark models/u);
});

test("pushes to main publish the default harnesses on the default model at the pushed commit", async () => {
  const input = fixture({ eventName: "push" });
  assert.deepEqual(await resolve(input), { ...defaults, sha: input.context.sha, pr: "" });
  assert.deepEqual(input.calls, []);
});

test("the weekly schedule publishes deepswe-lean for the default harnesses on every model", async () => {
  const input = fixture({ eventName: "schedule" });
  assert.deepEqual(await resolve(input), {
    ...defaults,
    ...deepsweLean,
    models: [anthropic, openai],
    sha: input.context.sha,
    pr: "",
  });
  assert.deepEqual(input.calls, []);
});

test("a family without a configured model fails instead of running the wrong model", async () => {
  const input = fixture({ eventName: "schedule" });
  input.models = { anthropic: models.anthropic, openai: "" };
  await assert.rejects(resolve(input), /No model is set for openai/u);
});

test("other events never run a benchmark", async () => {
  assert.equal(await resolve(fixture({ eventName: "workflow_run" })), null);
});

test("workflow names and concurrency preserve independent authorized harness runs", async () => {
  const workflow = await readFile(
    new URL("../workflows/eve-code-benchmark.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^name: eve-code\n/u);
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/u);
  assert.match(
    workflow,
    /needs: request\n\s+if: needs\.request\.outputs\.run == 'true'\n\s+concurrency:/u,
  );
  assert.match(workflow, /push:\n\s+branches: \[main\]/u);
  // Each dataset's attempts run in waves of the action's maximum of 16 sandboxes.
  assert.match(workflow, /attempts: \$\{\{ needs\.request\.outputs\.attempts \}\}/u);
  assert.match(workflow, /concurrency: "16"/u);
  assert.match(
    workflow,
    /agent-ref: \$\{\{ needs\.request\.outputs\.agent-source == 'true' && needs\.request\.outputs\.sha \|\| '' \}\}/u,
  );
});

test("the consumer tracks eve-bench main and owns its model selection", async () => {
  const workflow = await readFile(
    new URL("../workflows/eve-code-benchmark.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /repository: vercel-labs\/eve-bench\n\s+ref: main\n/u);
  assert.match(workflow, /uses: \.\/\.eve-bench-action/u);
  assert.match(workflow, /reasoning: \$\{\{ needs\.request\.outputs\.reasoning \}\}\n/u);
  assert.doesNotMatch(workflow, /runner-revision:/u);
  assert.match(workflow, /blob-token: \$\{\{ secrets\.EVE_BENCH_BLOB_READ_WRITE_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /artifact-id/u);
  assert.match(workflow, /dataset: \$\{\{ needs\.request\.outputs\.dataset \}\}\n/u);
  assert.match(
    workflow,
    /contenders: \$\{\{ needs\.request\.outputs\.agent-source == 'true' && 'eve-code@baseline,eve-code@head' \|\| '' \}\}\n/u,
  );
  assert.doesNotMatch(workflow, /^\s+task:/mu);
  assert.equal((workflow.match(/uses: \.\/\.eve-bench-action/gu) ?? []).length, 1);
});
