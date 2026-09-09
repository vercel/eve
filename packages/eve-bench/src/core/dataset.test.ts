// syncDataset is intentionally untested because it performs network and git operations.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { datasetDir, readCohort, readDatasetLock, taskDirs } from "./dataset.ts";

const root = await mkdtemp(join(tmpdir(), "eve-bench-dataset-"));
after(() => rm(root, { recursive: true, force: true }));

const VALID_LOCK = {
  name: "terminal-bench",
  version: "2.0",
  gitUrl: "https://github.com/laude-institute/terminal-bench-2.git",
  commit: "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c",
  tasks: ["adaptive-rejection-sampler", "fix-git"],
};

test("parses a valid dataset lock", async () => {
  const path = join(root, "valid-lock.json");
  await writeFile(path, JSON.stringify(VALID_LOCK));

  const lock = await readDatasetLock(path);

  assert.deepEqual(lock, VALID_LOCK);
});

for (const field of ["name", "version", "gitUrl", "commit"] as const) {
  test(`rejects a dataset lock missing ${field}`, async () => {
    const path = join(root, `missing-${field}.json`);
    const lock: Record<string, unknown> = { ...VALID_LOCK };
    delete lock[field];
    await writeFile(path, JSON.stringify(lock));

    await assert.rejects(readDatasetLock(path), {
      message: `${path}: missing "${field}"`,
    });
  });

  test(`rejects a dataset lock with an empty ${field}`, async () => {
    const path = join(root, `empty-${field}.json`);
    await writeFile(path, JSON.stringify({ ...VALID_LOCK, [field]: "" }));

    await assert.rejects(readDatasetLock(path), {
      message: `${path}: missing "${field}"`,
    });
  });
}

test("rejects a dataset lock with an empty tasks array", async () => {
  const path = join(root, "empty-lock-tasks.json");
  await writeFile(path, JSON.stringify({ ...VALID_LOCK, tasks: [] }));

  await assert.rejects(readDatasetLock(path), {
    message: `${path}: "tasks" must be a non-empty array`,
  });
});

test("rejects a cohort missing dataset", async () => {
  const path = join(root, "missing-cohort-dataset.json");
  await writeFile(path, JSON.stringify({ tasks: ["fix-git"] }));

  await assert.rejects(readCohort(path), {
    message: `${path}: missing "dataset"`,
  });
});

test("rejects a cohort with an empty tasks array", async () => {
  const path = join(root, "empty-cohort-tasks.json");
  await writeFile(path, JSON.stringify({ dataset: "terminal-bench-2.0", tasks: [] }));

  await assert.rejects(readCohort(path), {
    message: `${path}: "tasks" must be a non-empty array`,
  });
});

test("builds the versioned dataset directory path", () => {
  assert.equal(datasetDir(root, VALID_LOCK), join(root, "terminal-bench-2.0"));
});

test("resolves task directories containing task.toml", async () => {
  const dir = join(root, "tasks-valid");
  await mkdir(join(dir, "task-a"), { recursive: true });
  await mkdir(join(dir, "nested", "task-b"), { recursive: true });
  await writeFile(join(dir, "task-a", "task.toml"), "");
  await writeFile(join(dir, "nested", "task-b", "task.toml"), "");

  const dirs = await taskDirs(dir, ["task-a", "nested/task-b"]);

  assert.deepEqual(dirs, [join(dir, "task-a"), join(dir, "nested", "task-b")]);
});

test("rejects when any task directory lacks task.toml", async () => {
  const dir = join(root, "tasks-missing-toml");
  await mkdir(join(dir, "present"), { recursive: true });
  await mkdir(join(dir, "missing"), { recursive: true });
  await writeFile(join(dir, "present", "task.toml"), "");

  await assert.rejects(taskDirs(dir, ["present", "missing"]), { code: "ENOENT" });
});
