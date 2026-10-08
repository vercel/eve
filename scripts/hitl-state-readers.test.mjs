import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allowanceGrowth, baseAllowances, countHitlStateReads } from "./hitl-state-readers.mjs";

test("counts accessor calls and session-state keys", () => {
  const source = [
    `import { readTurnState } from "#harness/session-machine/state.js";`,
    `const turn = readTurnState(session);`,
    `const raw = session.state["eve.runtime.pendingAuthorization"];`,
    `// readTurnState(session) in a comment is not a read`,
  ].join("\n");
  assert.equal(countHitlStateReads(source), 2);
});

test("counts calls through an aliased import or a renamed destructuring", () => {
  const imported = [
    `import { readTurnState as turnOf } from "#harness/session-machine/state.js";`,
    `const turn = turnOf(session);`,
  ].join("\n");
  assert.equal(countHitlStateReads(imported), 1);
  const destructured = [
    `const { getProxyInputRequests: routes } = proxy;`,
    `const open = routes(session);`,
  ].join("\n");
  assert.equal(countHitlStateReads(destructured), 1);
});

test("doesn't take an object key named like an accessor for an alias", () => {
  assert.equal(
    countHitlStateReads(`return { hasPendingAuthorization: openSignIns(p).length > 0 };`),
    0,
  );
});

test("allowances may shrink from the base's, never grow or appear", () => {
  const base = { "a.ts": 2, "b.ts": 1 };
  assert.deepEqual(allowanceGrowth({ "a.ts": 1 }, base), []);
  assert.deepEqual(allowanceGrowth({ "a.ts": 3, "b.ts": 1, "c.ts": 1 }, base), [
    { file: "a.ts", now: 3, was: 2 },
    { file: "c.ts", now: 1, was: 0 },
  ]);
  // The base before the rule: the branch introducing it sets the allowances.
  assert.deepEqual(allowanceGrowth({ "a.ts": 3 }, undefined), []);
});

test("reads the allowances at the merge base with origin/main", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-hitl-state-readers-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
  const write = (allowances) =>
    writeFile(join(root, "scripts/baseline.json"), JSON.stringify({ rule: allowances }));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  await mkdir(join(root, "scripts"));
  await write({ "a.ts": 2 });
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-qc", "branch");
  await write({ "a.ts": 5 });
  git("commit", "-qam", "raise");

  assert.deepEqual(baseAllowances(root, "scripts/baseline.json", "rule"), { "a.ts": 2 });
  assert.equal(baseAllowances(root, "scripts/baseline.json", "missing"), undefined);
});

test("before origin/main has allowances, holds later commits to the branch's first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-hitl-state-readers-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
  const write = (baseline) =>
    writeFile(join(root, "scripts/baseline.json"), JSON.stringify(baseline));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  await mkdir(join(root, "scripts"));
  await write({});
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-qc", "branch");
  await write({ rule: { "a.ts": 2 } });
  git("commit", "-qam", "introduce");
  assert.deepEqual(baseAllowances(root, "scripts/baseline.json", "rule"), { "a.ts": 2 });
  await write({ rule: { "a.ts": 5 } });
  git("commit", "-qam", "raise");
  assert.deepEqual(baseAllowances(root, "scripts/baseline.json", "rule"), { "a.ts": 2 });
});
