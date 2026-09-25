import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copySource, hashTree, includeSource } from "./snapshot.ts";

test("source filter excludes generated and secret-bearing files", () => {
  for (const path of [
    "node_modules",
    ".git",
    ".eve",
    ".output",
    ".next",
    "dist",
    ".env",
    ".env.local",
    ".eve-bench-work",
  ]) {
    assert.equal(includeSource(path), false, path);
  }
  assert.equal(includeSource("agent.ts"), true);
});

test("hashTree is content-sensitive and copySource preserves its identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-bench-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "agent.ts"), "export default 1;\n");
  await writeFile(join(source, "nested/file.txt"), "one\n");
  const before = await hashTree(source);
  await copySource(source, destination);
  assert.equal(await hashTree(destination), before);
  await writeFile(join(source, "nested/file.txt"), "two\n");
  assert.notEqual(await hashTree(source), before);
});

test("hashTree rejects symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-bench-source-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "target"), "data");
  await symlink(join(root, "target"), join(root, "link"));
  await assert.rejects(hashTree(root), /does not support symlinks/);
});
