import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = readFileSync(new URL("../../extension/instructions.md", import.meta.url), "utf8");

test("static instructions carry no GitHub or pull request workflow", () => {
  assert.doesNotMatch(
    content,
    /GitHub credentials|`gh` tool|pr skill|gh-signed-commit|gh pr create/u,
  );
});
