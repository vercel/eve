import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("rule 50 keeps requests storage private with only the save and migration exceptions", async () => {
  const source = await readFile(new URL("./guard-invariants.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("rule52"));
  const rule = source.slice(
    source.indexOf("const HUMAN_INPUT_PRIVATE_IMPORT_RE"),
    source.indexOf("// ---------- Rule 51"),
  );
  const expression = rule.match(/  (\/.*\/);/)[1];
  const pattern = new RegExp(expression.slice(1, -1));
  assert.ok(pattern.test('from "#harness/hitl/requests.js"'));
  assert.ok(pattern.test('from "../hitl/requests.js"'));
  assert.ok(!pattern.test('from "#harness/hitl/index.js"'));
  assert.ok(rule.includes('posix === "packages/eve/src/harness/session-machine/commit.ts"'));
  assert.ok(
    rule.includes('posix === "packages/eve/src/execution/session/checkpoint-migrations.ts"'),
  );
  const check = new Function(
    "HUMAN_INPUT_DIR",
    "HUMAN_INPUT_PRIVATE_IMPORT_RE",
    rule.slice(rule.indexOf("function checkRule50")) + "; return checkRule50;",
  )("packages/eve/src/harness/hitl/", pattern);
  for (const file of [
    "packages/eve/src/execution/new-step.ts",
    "packages/eve/src/harness/other.ts",
  ]) {
    const violations = [];
    check(
      file,
      ['import { writeHitlState as save } from "#harness/hitl/requests.js";'],
      violations,
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 50);
    const readers = [];
    check(file, ['import { readHitlState } from "#harness/hitl/index.js";'], readers);
    assert.equal(readers.length, 0);
  }
  for (const file of [
    "packages/eve/src/harness/session-machine/commit.ts",
    "packages/eve/src/execution/session/checkpoint-migrations.ts",
  ]) {
    const violations = [];
    check(file, ['import * as requests from "#harness/hitl/requests.js";'], violations);
    assert.equal(violations.length, 0);
  }
});
