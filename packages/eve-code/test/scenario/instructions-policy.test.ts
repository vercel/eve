import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = readFileSync(new URL("../../extension/instructions.md", import.meta.url), "utf8");

test("routes authenticated GitHub operations through the scoped gh tool", () => {
  assert.match(content, /GitHub credentials are not available to ordinary `bash`/u);
  assert.match(content, /Use the `gh` tool for every authenticated GitHub operation/u);
  assert.match(content, /sandbox process receives only a placeholder `GH_TOKEN`/u);
});
