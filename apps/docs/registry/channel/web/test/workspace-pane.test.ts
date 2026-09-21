import assert from "node:assert/strict";
import { test } from "node:test";
import { readWorkspacePane } from "../lib/workspace-pane.ts";

test("restores only supported views belonging to the current conversation", () => {
  const pane = {
    kind: "subagent",
    payload: { sessionId: "parent", childSessionId: "child", callId: "call", name: "worker" },
  };
  assert.deepEqual(readWorkspacePane(JSON.stringify(pane), "parent"), pane);
  assert.equal(readWorkspacePane(JSON.stringify(pane), "other"), undefined);
  assert.equal(
    readWorkspacePane(
      JSON.stringify({ kind: "iframe", payload: { url: "https://example.com" } }),
      "parent",
    ),
    undefined,
  );
  assert.equal(readWorkspacePane("invalid", "parent"), undefined);
  assert.equal(
    readWorkspacePane(
      JSON.stringify({ ...pane, payload: { ...pane.payload, callId: null } }),
      "parent",
    ),
    undefined,
  );
});

test("nested selections retain their root scope independently of the immediate parent", () => {
  const pane = {
    kind: "subagent",
    rootSessionId: "root",
    payload: { sessionId: "childA", childSessionId: "childB", callId: "b", name: "B" },
  };
  assert.deepEqual(readWorkspacePane(JSON.stringify(pane), "root"), pane);
  assert.equal(readWorkspacePane(JSON.stringify(pane), "childA"), undefined);
});
