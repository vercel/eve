import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeId } from "./id.ts";

test("accepts bounded path- and Docker-safe identifiers", () => {
  for (const value of ["job", "task-1", "a.b_c", `a${"x".repeat(127)}`]) {
    assert.equal(assertSafeId(value, "job"), value);
  }
});

test("rejects traversal, separators, labels, whitespace, and oversized identifiers", () => {
  for (const value of ["", ".", "..", "../job", "a/b", "a:b", "two words", `a${"x".repeat(128)}`]) {
    assert.throws(() => assertSafeId(value, "task"), /path- and Docker-safe/);
  }
});
