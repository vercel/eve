import assert from "node:assert/strict";
import { test } from "vitest";

import plugin from "@tools/oxlint/anti-slop/index.ts";

import "./no-chained-type-assertions.cases.ts";
import "./no-conditional-empty-object-spread.cases.ts";
import "./no-known-value-widening.cases.ts";
import "./no-module-mocking.cases.ts";
import "./no-object-parameters.cases.ts";
import "./no-reflect-apply.cases.ts";
import "./no-reflect-get.cases.ts";
import "./no-runtime-typeof.cases.ts";
import "./no-shape-in-symbol-names.cases.ts";
import "./no-unknown-parameters.cases.ts";
import "./no-unknown-returns.cases.ts";
import "./no-unknown-type-aliases.cases.ts";
import "./no-unsafe-dictionary-type.cases.ts";
import "./no-widen-then-assert.cases.ts";
import "./require-safety-comment-for-type-assertion.cases.ts";

const registeredRuleNames = [
  "no-chained-type-assertions",
  "no-conditional-empty-object-spread",
  "no-known-value-widening",
  "no-module-mocking",
  "no-object-parameters",
  "no-reflect-apply",
  "no-reflect-get",
  "no-runtime-typeof",
  "no-shape-in-symbol-names",
  "no-unknown-parameters",
  "no-unknown-returns",
  "no-unknown-type-aliases",
  "no-unsafe-dictionary-type",
  "no-widen-then-assert",
  "require-safety-comment-for-type-assertion",
];

test("exports every repository-vendored anti-slop rule", () => {
  assert.deepEqual(Object.keys(plugin.rules).toSorted(), registeredRuleNames);
});

test("does not advertise automatic fixes for policy-only diagnostics", () => {
  for (const rule of Object.values(plugin.rules)) {
    assert.equal(rule.meta?.fixable, undefined);
  }
});
