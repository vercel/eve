import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseTranscript } from "@vercel/agent-eval";

import { publishResults } from "./publish-results.mjs";

const plan = {
  sha: "a".repeat(40),
  eve_revision: "b".repeat(40),
  treatment: "guided",
  models: ["kimi-k3", "claude-fable-5-1"],
  cases: ["author-001-weather-tool"],
  runs: 2,
};
const docs = "/vercel/sandbox/node_modules/eve/docs";

function artifactsDirectory(t, meta = {}, run = "run-1") {
  const root = mkdtempSync(join(tmpdir(), "eve-authoring-publish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = join(root, `authoring-benchmark-kimi-k3-${plan.sha}`);
  const runPath = join(artifact, "current/2026-10-26T00-00-00.000Z/author-001-weather-tool", run);
  mkdirSync(runPath, { recursive: true });
  writeFileSync(
    join(artifact, "meta.json"),
    JSON.stringify({
      model_id: "kimi-k3",
      sha: plan.sha,
      eve_revision: plan.eve_revision,
      treatment: plan.treatment,
      runner_os: "Linux",
      ...meta,
    }),
  );
  const raw = [
    {
      type: "tool_use",
      part: {
        tool: "read",
        state: { status: "completed", input: { filePath: `${docs}/README.md` }, output: "" },
      },
    },
    { type: "text", part: { text: "Done." } },
    { type: "step_finish", part: { tokens: { input: 1_000_000, output: 0, cache: { read: 0 } } } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  writeFileSync(join(runPath, "transcript-raw.jsonl"), raw);
  writeFileSync(
    join(runPath, "transcript.json"),
    JSON.stringify(parseTranscript(raw, "vercel-ai-gateway/opencode")),
  );
  writeFileSync(join(runPath, "result.json"), JSON.stringify({ status: "passed", duration: 12 }));
  return root;
}

function memoryStore() {
  const objects = new Map();
  const writes = [];
  return {
    objects,
    writes,
    async put(pathname, body) {
      if (objects.has(pathname))
        throw new Error(`Vercel Blob: This blob already exists (${pathname}).`);
      objects.set(pathname, Buffer.from(body));
      writes.push(pathname);
    },
    async read(pathname) {
      return objects.get(pathname) ?? null;
    },
  };
}

test("publishes raw results and per-run records before the manifest, immutably", async (t) => {
  const store = memoryStore();
  const input = {
    plan,
    artifactsDir: artifactsDirectory(t),
    githubRunId: "123",
    runAttempt: 1,
    publishedAt: "2026-10-27T07:00:00.000Z",
    store,
  };

  const result = await publishResults(input);
  const prefix = "authoring/runs/123/1";
  assert.equal(result.prefix, prefix);
  assert.equal(store.writes.at(-1), `${prefix}/manifest.json`);
  const rawPath = "current/2026-10-26T00-00-00.000Z/author-001-weather-tool/run-1";
  assert(store.objects.has(`${prefix}/raw/kimi-k3/${rawPath}/transcript.json`));

  const records = store.objects
    .get(`${prefix}/records.jsonl`)
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // Every planned (model, case, run) has a record; unrun ones are `missing`.
  assert.deepEqual(
    records.map(({ model_id, run, outcome }) => ({ model_id, run, outcome })),
    [
      { model_id: "kimi-k3", run: 1, outcome: "passed" },
      { model_id: "kimi-k3", run: 2, outcome: "missing" },
      { model_id: "claude-fable-5-1", run: 1, outcome: "missing" },
      { model_id: "claude-fable-5-1", run: 2, outcome: "missing" },
    ],
  );
  const [measured] = records;
  assert.equal(measured.raw_path, `raw/kimi-k3/${rawPath}`);
  assert.equal(measured.harness, "OpenCode");
  assert.equal(measured.turns, 1);
  assert.equal(measured.duration_s, 12);
  assert.equal(measured.agent_s, null, "no timings.json is unavailable, not zero");
  assert.equal(measured.usage.input_tokens, 1_000_000);
  assert.equal(measured.cost_usd, 3, "priced at kimi-k3's $3 per 1M input tokens");
  assert.deepEqual(measured.docs_read, { "README.md": 1 });

  const manifest = JSON.parse(store.objects.get(`${prefix}/manifest.json`));
  assert.equal(manifest.published_at, "2026-10-27T07:00:00.000Z");
  assert.equal(manifest.files.records.count, 4);
  assert.deepEqual(
    manifest.models.map(({ model_id, uploaded }) => ({ model_id, uploaded })),
    [
      { model_id: "kimi-k3", uploaded: true },
      { model_id: "claude-fable-5-1", uploaded: false },
    ],
  );

  const writes = store.writes.length;
  await publishResults({ ...input, publishedAt: "2026-10-27T08:00:00.000Z" });
  assert.equal(store.writes.length, writes, "a retry keeps the first publish time and is a no-op");
  await assert.rejects(
    publishResults({ ...input, plan: { ...plan, runs: 1 } }),
    /records.jsonl was already published with different content/,
  );
});

test("rejects artifacts that ran another revision, an unplanned model, or an unplanned run", async (t) => {
  const input = { plan, githubRunId: "123", runAttempt: 1, store: memoryStore() };
  await assert.rejects(
    publishResults({ ...input, artifactsDir: artifactsDirectory(t, { sha: "c".repeat(40) }) }),
    /sha is "c+", but the plan has "a+"/,
  );
  await assert.rejects(
    publishResults({ ...input, artifactsDir: artifactsDirectory(t, { model_id: "grok-4-6" }) }),
    /model "grok-4-6" was not planned/,
  );
  await assert.rejects(
    publishResults({ ...input, artifactsDir: artifactsDirectory(t, {}, "run-3") }),
    /"run-3" is outside the planned run-1\.\.run-2/,
  );
});

test("reads a single artifact that download-artifact unpacked straight into the directory", async (t) => {
  // With one matching artifact, actions/download-artifact skips the
  // `<artifact-name>/` subdirectory, so meta.json lands at the root.
  const root = artifactsDirectory(t);
  const nested = join(root, `authoring-benchmark-kimi-k3-${plan.sha}`);
  const flat = mkdtempSync(join(tmpdir(), "eve-authoring-flat-"));
  t.after(() => rmSync(flat, { recursive: true, force: true }));
  cpSync(nested, flat, { recursive: true });

  const store = memoryStore();
  await publishResults({ plan, artifactsDir: flat, githubRunId: "123", runAttempt: 1, store });
  const prefix = "authoring/runs/123/1";
  const rawPath = "current/2026-10-26T00-00-00.000Z/author-001-weather-tool/run-1";
  assert(store.objects.has(`${prefix}/raw/kimi-k3/${rawPath}/transcript.json`));
  const [first] = store.objects
    .get(`${prefix}/records.jsonl`)
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(first.outcome, "passed");
  assert.equal(first.raw_path, `raw/kimi-k3/${rawPath}`);
});
