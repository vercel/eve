import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";

import { runJob, type JobInput } from "../../src/core/job.ts";
import { hashTask, identityHash } from "../../src/core/job-identity.ts";
import { loadTask } from "../../src/core/task.ts";
import type { TrialResult } from "../../src/core/result.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "eve-bench-resume-"));
  const bin = join(root, "bin");
  const calls = join(root, "docker-calls.jsonl");
  const containers = join(root, "containers.json");
  const taskDir = join(root, "tasks", "a");
  await mkdir(bin);
  for (const dir of ["environment", "tests", "solution"])
    await mkdir(join(taskDir, dir), { recursive: true });
  await writeFile(join(taskDir, "instruction.md"), "Do the task.\n");
  await writeFile(join(taskDir, "task.toml"), '[task]\nname = "a"\n');
  await writeFile(join(taskDir, "environment", "Dockerfile"), "FROM scratch\n");
  await writeFile(join(taskDir, "environment", "input.bin"), Buffer.from([0, 255, 1]));
  await writeFile(join(taskDir, "tests", "test.sh"), "true\n");
  await writeFile(join(taskDir, "solution", "solve.sh"), "true\n");
  await writeFile(calls, "");
  await writeFile(containers, "[]");
  // No daemon or model is used: every Docker invocation terminates in this local stub.
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'version') console.log('fake-docker');
else if (args[0] === 'ps') for (const row of JSON.parse(readFileSync(${JSON.stringify(containers)}, 'utf8'))) console.log(JSON.stringify(row));
else if (args[0] === 'rm') writeFileSync(${JSON.stringify(containers)}, '[]');
else if (args[0] === 'exec') console.log('/workspace');
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });
  const input: JobInput = {
    name: basename(root),
    dir: join(root, "job"),
    cacheDir: join(root, "cache"),
    dataset: {
      name: "bench",
      version: "2",
      gitUrl: "https://example.com/tasks",
      commit: "abc",
      tasks: ["a"],
    },
    tasks: [await loadTask(taskDir)],
    harness: {
      name: "fake",
      prepare: async () => ({
        dir: bin,
        provenance: { key: "v1", source: { sha: "abc", dirty: false } },
      }),
      command: () => "true",
      env: () => ({}),
    },
    model: "no-model",
    attempts: 1,
    concurrency: 1,
    forwardEnv: {},
    signal: new AbortController().signal,
  };
  const trial: TrialResult = {
    task: "a",
    attempt: 1,
    harness: "fake",
    model: "no-model",
    reward: 1,
    agent: { status: "completed", exitCode: 0, durationMs: 1 },
    verifier: { status: "completed", exitCode: 0, durationMs: 1 },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
  async function initialize() {
    await runJob({ ...input, signal: AbortSignal.abort() });
    await mkdir(join(input.dir, "a", "1"), { recursive: true });
    await writeFile(join(input.dir, "a", "1", "trial.json"), JSON.stringify(trial));
    await writeFile(calls, "");
  }
  async function leftovers() {
    await writeFile(
      containers,
      JSON.stringify([
        {
          ID: "leftover",
          Names: "leftover",
          Labels: `eve-bench=1,eve-bench.job=${input.name}`,
          CreatedAt: "yesterday",
        },
      ]),
    );
  }
  return { root, input, taskDir, calls, containers, trial, initialize, leftovers };
}

async function snapshot(dir: string) {
  return Promise.all(
    ["job.json", "result.json", "a/1/trial.json"].map((file) => readFile(join(dir, file), "utf8")),
  );
}

test("every resume identity mismatch rejects before metadata/results overwrite or Docker cleanup", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  await f.leftovers();
  const before = await snapshot(f.input.dir);
  const changes: Partial<JobInput>[] = [
    { model: "different" },
    { attempts: 2 },
    { harness: { ...f.input.harness, name: "other" } },
    {
      harness: {
        ...f.input.harness,
        prepare: async () => ({ dir: f.root, provenance: { key: "v2" } }),
      },
    },
    { tasks: [{ ...f.input.tasks[0]!, name: "renamed" }] },
    { tasks: [] },
    { tasks: [...f.input.tasks, { ...f.input.tasks[0]!, name: "added" }] },
    { tasks: [{ ...f.input.tasks[0]!, instruction: "Loaded instruction override" }] },
    { tasks: [{ ...f.input.tasks[0]!, agentTimeoutMs: 123 }] },
    ...(["name", "version", "gitUrl", "commit"] as const).map((key) => ({
      dataset: { ...f.input.dataset, [key]: "changed" },
    })),
  ];
  for (const change of changes) {
    await assert.rejects(
      runJob({ ...f.input, ...change }),
      /resume identity differs.*new job name/,
    );
    assert.deepEqual(await snapshot(f.input.dir), before);
    assert.equal(await readFile(f.calls, "utf8"), "");
  }
  for (const path of [
    "instruction.md",
    "task.toml",
    "tests/test.sh",
    "environment/Dockerfile",
    "environment/input.bin",
    "solution/solve.sh",
  ]) {
    const file = join(f.taskDir, path);
    const content = await readFile(file);
    await writeFile(file, Buffer.concat([content, Buffer.from("changed")]));
    await assert.rejects(runJob(f.input), /differs \(tasks\).*new job name/);
    assert.deepEqual(await snapshot(f.input.dir), before);
    assert.equal(await readFile(f.calls, "utf8"), "");
    await writeFile(file, content);
  }
});

test("matching resume keeps original metadata and cached trials, and then cleans leftovers", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const before = await snapshot(f.input.dir);
  await f.leftovers();
  const seen: boolean[] = [];
  const result = await runJob({
    ...f.input,
    concurrency: 4,
    forwardEnv: { FAKE_KEY: "not-identity-or-metadata" },
    harness: {
      ...f.input.harness,
      prepare: async () => ({
        dir: f.root,
        provenance: { source: { dirty: false, sha: "abc" }, key: "v1" },
      }),
    },
    onTrial: (_trial, resumed) => seen.push(resumed),
  });
  assert.deepEqual(result.trials, [f.trial]);
  assert.deepEqual(seen, [true]);
  const after = await snapshot(f.input.dir);
  assert.equal(after[0], before[0]);
  assert.equal(after[2], before[2]);
  assert.match(await readFile(f.calls, "utf8"), /\["rm","--force","--volumes","leftover"\]/);
  assert.doesNotMatch(await readFile(f.calls, "utf8"), /\["run"/);
  assert.equal(await readFile(f.containers, "utf8"), "[]");
});

test("legacy, malformed, unsupported and orphaned jobs refuse without preparation or Docker calls", async (t) => {
  const f = await fixture(t);
  await mkdir(f.input.dir);
  let prepared = false;
  const input = {
    ...f.input,
    harness: {
      ...f.input.harness,
      prepare: async () => {
        prepared = true;
        throw new Error("must not prepare");
      },
    },
  };
  for (const text of [
    JSON.stringify({ job: f.input.name, harness: "fake" }),
    "{invalid",
    "null",
    JSON.stringify({ identity: { version: 2 } }),
  ]) {
    await writeFile(join(input.dir, "job.json"), text);
    await assert.rejects(runJob(input), /new job name/);
    assert.equal(await readFile(join(input.dir, "job.json"), "utf8"), text);
  }
  await rm(join(input.dir, "job.json"));
  await writeFile(join(input.dir, "result.json"), "orphaned");
  await assert.rejects(runJob(input), /no job.json.*new job name/);
  assert.equal(await readFile(join(input.dir, "result.json"), "utf8"), "orphaned");
  assert.equal(prepared, false);
  assert.equal(await readFile(f.calls, "utf8"), "");
});

test("task hashes are relocatable and ignore unselected trees and mtimes, but include paths and executable bits", async (t) => {
  const f = await fixture(t);
  const original = await hashTask(f.input.tasks[0]!);
  const relocated = join(f.root, "relocated");
  await cp(f.taskDir, relocated, { recursive: true });
  const task = await loadTask(relocated);
  assert.equal(await hashTask(task), original);
  await utimes(join(relocated, "instruction.md"), new Date(0), new Date(0));
  await writeFile(join(f.root, "tasks", "unselected"), "does not affect a");
  assert.equal(await hashTask(task), original);
  await rename(
    join(relocated, "environment", "input.bin"),
    join(relocated, "environment", "renamed.bin"),
  );
  assert.notEqual(await hashTask(task), original);
  await rename(
    join(relocated, "environment", "renamed.bin"),
    join(relocated, "environment", "input.bin"),
  );
  await chmod(join(relocated, "solution", "solve.sh"), 0o755);
  assert.notEqual(await hashTask(task), original);
  await chmod(join(relocated, "solution", "solve.sh"), 0o644);
  assert.equal(await hashTask(task), original);
  await rm(join(relocated, "environment", "input.bin"));
  assert.notEqual(await hashTask(task), original);
});

test("task hashing refuses symlinks and environments outside the selected tree", async (t) => {
  const f = await fixture(t);
  await symlink(f.calls, join(f.taskDir, "external"));
  await assert.rejects(hashTask(f.input.tasks[0]!), /regular files\/directories/);
  await rm(join(f.taskDir, "external"));
  const task = f.input.tasks[0]!;
  await assert.rejects(
    hashTask({ ...task, environment: { ...task.environment, dockerfileDir: f.root } }),
    /inside the selected task tree/,
  );
});

test("an aborted job retains its identity, releases the lock, and resumes the same remaining work", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const input = { ...f.input, attempts: 2 };
  const partial = await runJob({
    ...input,
    signal: controller.signal,
    onTrial: () => controller.abort(),
  });
  assert.equal(partial.trials.length, 1);
  const metadata = await readFile(join(input.dir, "job.json"), "utf8");
  const seen: boolean[] = [];
  const result = await runJob({ ...input, onTrial: (_trial, resumed) => seen.push(resumed) });
  assert.deepEqual(seen, [true, false]);
  assert.equal(result.trials.length, 2);
  assert.deepEqual(result.trials[0], partial.trials[0]);
  assert.equal(await readFile(join(input.dir, "job.json"), "utf8"), metadata);
});

test("same-job lock rejects concurrent runs even in another output directory, and releases on failure", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const before = await snapshot(f.input.dir);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = runJob({
    ...f.input,
    harness: {
      ...f.input.harness,
      prepare: async () => {
        enter();
        await released;
        return f.input.harness.prepare({ model: f.input.model, cacheDir: f.input.cacheDir });
      },
    },
  });
  try {
    await entered;
    await assert.rejects(runJob(f.input), /is locked.*active run/);
    const otherDir = join(f.root, "other-job-dir");
    await assert.rejects(runJob({ ...f.input, dir: otherDir }), /is locked/);
    assert.deepEqual(await snapshot(f.input.dir), before);
    assert.equal(await readFile(f.calls, "utf8"), "");
    assert.ok(!(await readdir(f.root)).includes("other-job-dir"));
  } finally {
    release();
    await active;
  }
  await assert.rejects(
    runJob({
      ...f.input,
      harness: {
        ...f.input.harness,
        prepare: async () => {
          throw new Error("prepare failed");
        },
      },
    }),
    /prepare failed/,
  );
  await runJob(f.input);
});

test("stale locks fail closed with explicit recovery, and unknown containers are not removed", async (t) => {
  const f = await fixture(t);
  const lock = join(tmpdir(), `eve-bench-job-${identityHash(f.input.name)}.lock`);
  await writeFile(lock, "crashed owner", { flag: "wx" });
  try {
    await assert.rejects(runJob(f.input), /confirm it has stopped before removing/);
    assert.equal(await readFile(lock, "utf8"), "crashed owner");
    assert.equal(await readFile(f.calls, "utf8"), "");
  } finally {
    await rm(lock);
  }
  await f.leftovers();
  const containers = await readFile(f.containers, "utf8");
  await assert.rejects(runJob(f.input), /containers but no resume identity.*new job name/);
  assert.equal(await readFile(f.containers, "utf8"), containers);
  assert.deepEqual(await readdir(f.input.dir), []);
  assert.doesNotMatch(await readFile(f.calls, "utf8"), /\["rm"/);
});
