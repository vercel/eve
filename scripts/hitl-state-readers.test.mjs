import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  allowanceGrowth,
  baseAllowances,
  countHitlStateReads,
  hitlStateAccessors,
  namesHitlStateKey,
} from "./hitl-state-readers.mjs";

const ACCESSORS = [
  "HITL_STATE_KEYS",
  "getProxyInputRequests",
  "readApprovalState",
  "writeHitlState",
];

test("takes every value the session-state module exports, past its read surface", () => {
  const source = [
    `export const HITL_STATE_KEYS = {} as const;`,
    `export function readHitlState(state) {}`,
    `export function writeHitlState(session, change) {}`,
    `export async function commitSomething() {}`,
    `export interface HitlState {}`,
    `export type RelayChange = {};`,
    `function privateHelper() {}`,
    `export function holdsHitlRequests(state) {}`,
  ].join("\n");
  assert.deepEqual(hitlStateAccessors(source), [
    "HITL_STATE_KEYS",
    "commitSomething",
    "writeHitlState",
  ]);
});

test("counts accessor calls, key-constant reads and session-state keys", () => {
  const source = [
    `import { readApprovalState, HITL_STATE_KEYS } from "#harness/hitl/session-state.js";`,
    `const approvals = readApprovalState(session);`,
    `const relays = state[HITL_STATE_KEYS.relays];`,
    `const raw = session.state["eve.runtime.pendingAuthorization"];`,
    `const folded = session.state["eve.runtime.hitl.requests"];`,
    `// readApprovalState(session) in a comment is not a read`,
  ].join("\n");
  assert.equal(countHitlStateReads(source, ACCESSORS), 4);
});

test("doesn't count the read view", () => {
  const source = [
    `import { readHitlState } from "#harness/hitl/session-state.js";`,
    `const { relays } = readHitlState(session.state);`,
  ].join("\n");
  assert.equal(countHitlStateReads(source, ACCESSORS), 0);
});

test("counts calls through an aliased import or a renamed destructuring", () => {
  const imported = [
    `import { readApprovalState as approvalsOf } from "#harness/hitl/session-state.js";`,
    `const approvals = approvalsOf(session);`,
  ].join("\n");
  assert.equal(countHitlStateReads(imported, ACCESSORS), 1);
  const destructured = [
    `const { getProxyInputRequests: routes } = proxy;`,
    `const open = routes(session);`,
  ].join("\n");
  assert.equal(countHitlStateReads(destructured, ACCESSORS), 1);
});

test("counts uses through a namespace import", () => {
  const source = [
    `import * as hitl from "#harness/hitl/session-state.js";`,
    `const approvals = hitl.readApprovalState(session);`,
    `const { relays } = hitl.readHitlState(session.state);`,
  ].join("\n");
  assert.equal(countHitlStateReads(source, ACCESSORS), 1);
});

test("doesn't take an object key or a member named like an accessor for a use", () => {
  assert.equal(
    countHitlStateReads(
      `return { readApprovalState: open(p), x: hitl.readApprovalState };`,
      ACCESSORS,
    ),
    0,
  );
});

test("finds session-state keys outside comments", () => {
  assert.equal(namesHitlStateKey(`const key = "eve.runtime.hitl.approvalState";`), true);
  assert.equal(namesHitlStateKey(`// the "eve.runtime.hitl.approvalState" key`), false);
  assert.equal(namesHitlStateKey(`const key = "eve.harness.turnState";`), false);
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
