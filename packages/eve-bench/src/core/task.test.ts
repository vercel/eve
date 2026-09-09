import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadTask } from "./task.ts";

const root = await mkdtemp(join(tmpdir(), "eve-bench-task-"));
after(() => rm(root, { recursive: true, force: true }));

const TASK_TOML = `schema_version = "1.1"
artifacts = []

[task]
name = "terminal-bench/adaptive-rejection-sampler"
keywords = ["applied-statistics", "simulation"]
[[task.authors]]
name = "jvpoulos"
email = "poulos@berkeley.edu"

[agent]
timeout_sec = 1.234

[verifier]
timeout_sec = 2.789

[environment]
build_timeout_sec = 3.456
docker_image = "alexgshaw/adaptive-rejection-sampler:20251031"
cpus = 1.5
memory_mb = 2048
allow_internet = true
mcp_servers = []

[verifier.env]

[environment.env]
`;

async function writeTask(dir: string, toml = TASK_TOML): Promise<void> {
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "task.toml"), toml);
  await writeFile(join(dir, "instruction.md"), "Solve the task.\n");
  await writeFile(join(dir, "tests", "test.sh"), "#!/bin/sh\n");
}

test("loads Terminal-Bench task fields and converts timeout seconds to milliseconds", async () => {
  const dir = join(root, "complete");
  await writeTask(dir);

  const task = await loadTask(dir);

  assert.equal(task.name, "adaptive-rejection-sampler");
  assert.equal(task.dir, dir);
  assert.equal(task.instruction, "Solve the task.\n");
  assert.equal(task.agentTimeoutMs, 1234);
  assert.equal(task.verifierTimeoutMs, 2789);
  assert.equal(task.buildTimeoutMs, 3456);
  assert.equal(task.environment.dockerImage, "alexgshaw/adaptive-rejection-sampler:20251031");
  assert.equal(task.environment.cpus, 1.5);
  assert.equal(task.environment.memoryMb, 2048);
  assert.equal(task.environment.allowInternet, true);
});

test('converts older-schema memory = "2G" to 2048 MB', async () => {
  const dir = join(root, "memory-2g");
  await writeTask(dir, TASK_TOML.replace("memory_mb = 2048", 'memory = "2G"'));

  const task = await loadTask(dir);

  assert.equal(task.environment.memoryMb, 2048);
});

test('converts older-schema memory = "512M" to 512 MB', async () => {
  const dir = join(root, "memory-512m");
  await writeTask(dir, TASK_TOML.replace("memory_mb = 2048", 'memory = "512M"'));

  const task = await loadTask(dir);

  assert.equal(task.environment.memoryMb, 512);
});

test("prefers memory_mb when both memory fields are present", async () => {
  const dir = join(root, "memory-precedence");
  await writeTask(dir, TASK_TOML.replace("memory_mb = 2048", 'memory_mb = 768\nmemory = "2G"'));

  const task = await loadTask(dir);

  assert.equal(task.environment.memoryMb, 768);
});

test("uses 15-minute defaults when agent and verifier timeouts are missing", async () => {
  const dir = join(root, "default-timeouts");
  const toml = TASK_TOML.replace("[agent]\ntimeout_sec = 1.234\n\n", "").replace(
    "[verifier]\ntimeout_sec = 2.789\n\n",
    "",
  );
  await writeTask(dir, toml);

  const task = await loadTask(dir);

  assert.equal(task.agentTimeoutMs, 900_000);
  assert.equal(task.verifierTimeoutMs, 900_000);
});

test("allows internet when allow_internet is absent", async () => {
  const dir = join(root, "internet-default");
  await writeTask(dir, TASK_TOML.replace("allow_internet = true\n", ""));

  const task = await loadTask(dir);

  assert.equal(task.environment.allowInternet, true);
});

test("disallows internet when allow_internet is false", async () => {
  const dir = join(root, "internet-false");
  await writeTask(dir, TASK_TOML.replace("allow_internet = true", "allow_internet = false"));

  const task = await loadTask(dir);

  assert.equal(task.environment.allowInternet, false);
});

test("rejects a task with neither docker_image nor environment/Dockerfile", async () => {
  const dir = join(root, "missing-image");
  await writeTask(
    dir,
    TASK_TOML.replace('docker_image = "alexgshaw/adaptive-rejection-sampler:20251031"\n', ""),
  );

  await assert.rejects(loadTask(dir), { code: "ENOENT" });
});

test("loads environment/Dockerfile when docker_image is absent", async () => {
  const dir = join(root, "dockerfile");
  await writeTask(
    dir,
    TASK_TOML.replace('docker_image = "alexgshaw/adaptive-rejection-sampler:20251031"\n', ""),
  );
  await mkdir(join(dir, "environment"));
  await writeFile(join(dir, "environment", "Dockerfile"), "FROM scratch\n");

  const task = await loadTask(dir);

  assert.equal(task.environment.dockerImage, undefined);
  assert.equal(task.environment.dockerfileDir, join(dir, "environment"));
});

test("rejects a task missing tests/test.sh", async () => {
  const dir = join(root, "missing-test");
  await writeTask(dir);
  await rm(join(dir, "tests", "test.sh"));

  await assert.rejects(loadTask(dir), { code: "ENOENT" });
});
