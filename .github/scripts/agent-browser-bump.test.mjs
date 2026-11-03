import assert from "node:assert/strict";
import test from "node:test";

import { diffCatalog, isNewer, parsePin, rewriteReadme } from "./agent-browser-bump.mjs";

test("parsePin reads the vendored version", () => {
  assert.equal(parsePin('export const AGENT_BROWSER_SANDBOX_VERSION = "0.41.1";\n'), "0.41.1");
  assert.throws(() => parsePin("export const OTHER = 1;"));
});

test("isNewer only accepts newer stable releases", () => {
  assert.equal(isNewer("0.42.0", "0.41.1"), true);
  assert.equal(isNewer("0.41.2", "0.41.1"), true);
  assert.equal(isNewer("1.0.0", "0.41.1"), true);
  assert.equal(isNewer("0.41.1", "0.41.1"), false);
  assert.equal(isNewer("0.40.9", "0.41.1"), false);
  assert.equal(isNewer("0.42.0-beta.1", "0.41.1"), false);
});

test("rewriteReadme moves every pin and cites the tag", () => {
  const readme = [
    "It targets agent-browser 0.41.1 and requires eve.",
    "installSpec: undefined, // defaults to agent-browser@0.41.1; must match its minor",
    "copied from `vercel-labs/agent-browser` at commit `2d1271b` (agent-browser 0.41.1), under Apache-2.0.",
  ].join("\n");
  assert.equal(
    rewriteReadme(readme, "0.41.1", "0.42.0"),
    [
      "It targets agent-browser 0.42.0 and requires eve.",
      "installSpec: undefined, // defaults to agent-browser@0.42.0; must match its minor",
      "copied from `vercel-labs/agent-browser` at tag `v0.42.0` (agent-browser 0.42.0), under Apache-2.0.",
    ].join("\n"),
  );
});

test("diffCatalog reports added, removed, changed, and broken tools", () => {
  const tool = (name, description = name) => ({ name: `agent_browser_${name}`, description });
  const before = { tools: [tool("click"), tool("fill"), tool("drag"), tool("pdf")] };
  const after = { tools: [tool("click", "new"), tool("fill"), tool("pdf", "new"), tool("tap")] };
  assert.deepEqual(diffCatalog(before, after, new Set(["click", "fill", "drag"])), {
    added: ["tap"],
    removed: ["drag"],
    changed: [
      { name: "click", exposed: true },
      { name: "pdf", exposed: false },
    ],
    broken: ["drag"],
  });
});
