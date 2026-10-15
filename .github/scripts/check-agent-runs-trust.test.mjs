import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const workflow = load(await readFile(new URL("../workflows/release.yml", import.meta.url), "utf8"));
const checkJob = workflow.jobs["check-agent-runs-trust"];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const check = new AsyncFunction("core", "fetch", checkJob.steps[0].with.script);

test("check-only dispatch excludes the release job and preserves ordinary releases", () => {
  const enabled = (job, eventName, checkOnly) =>
    new Function("github", "inputs", `return (${job.if});`)(
      { event_name: eventName },
      { check_agent_runs_trust: checkOnly },
    );
  assert.equal(workflow.on.workflow_dispatch.inputs.check_agent_runs_trust.default, false);
  for (const [eventName, checkOnly, release, checkTrust] of [
    ["push", undefined, true, false],
    ["workflow_dispatch", false, true, false],
    ["workflow_dispatch", true, false, true],
  ]) {
    assert.equal(enabled(workflow.jobs.release, eventName, checkOnly), release);
    assert.equal(enabled(checkJob, eventName, checkOnly), checkTrust);
  }
});

function fixture(response) {
  const requests = [];
  const logs = [];
  const secrets = [];
  const failures = [];
  const core = {
    async getIDToken(audience) {
      assert.equal(audience, "npm:registry.npmjs.org");
      return "github-test-credential";
    },
    setSecret: (value) => secrets.push(value),
    info: (message) => logs.push(message),
    setFailed: (message) => failures.push(message),
  };
  return {
    requests,
    logs,
    secrets,
    failures,
    run: () =>
      check(core, async (url, options) => {
        requests.push({ url, options });
        if (response instanceof Error) throw response;
        return response;
      }),
  };
}

test("the trust check only exchanges OIDC credentials and does not publish or log them", async () => {
  const input = fixture(Response.json({ token: "npm-test-credential" }));
  await input.run();
  assert.equal(input.requests.length, 1);
  const [{ url, options }] = input.requests;
  assert.equal(
    url,
    "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@vercel%2Fagent-runs",
  );
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer github-test-credential");
  assert.equal(options.redirect, "error");
  assert.equal(options.signal instanceof AbortSignal, true);
  assert.deepEqual(input.failures, []);
  assert.deepEqual(input.secrets, ["github-test-credential", "npm-test-credential"]);
  assert.match(input.logs.join("\n"), /Direct publish permission was not tested/u);
  assert.doesNotMatch(input.logs.join("\n"), /test-credential/u);
});

test("npm rejection fails the check without disclosing response content", async () => {
  const input = fixture(new Response("private response details", { status: 403 }));
  await input.run();
  assert.equal(input.failures.length, 1);
  assert.match(input.failures[0], /HTTP 403/u);
  assert.doesNotMatch(input.failures[0], /private response details/u);
  assert.deepEqual(input.logs, []);
});

test("a response without a credential cannot count as successful trust", async () => {
  const input = fixture(Response.json({}));
  await input.run();
  assert.equal(input.failures.length, 1);
  assert.deepEqual(input.logs, []);
});

test("request failures do not disclose exception details", async () => {
  const input = fixture(new Error("private request details"));
  await input.run();
  assert.equal(input.failures.length, 1);
  assert.doesNotMatch(input.failures[0], /private request details/u);
  assert.deepEqual(input.logs, []);
});
