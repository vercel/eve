import assert from "node:assert/strict";
import test from "node:test";

import {
  admitted,
  AUDIENCE_DENIED_REASON,
  decideAudience,
  decidePrivateContext,
  initialPersonalContext,
  MAX_SOURCES,
  readsPersonal,
  requested,
  settled,
  strictestOf,
  type PersonalContext,
} from "../../extension/lib/private-context.ts";

function read(state: PersonalContext, callId: string, name: string, outcome = "completed") {
  return settled(requested(state, callId, name), callId, outcome);
}

const holding = read(admitted(initialPersonalContext(), "alice"), "call-1", "notion_search");

test("records the caller as the owner of a completed personal read", () => {
  assert.deepEqual(holding, {
    caller: "alice",
    owners: ["alice"],
    pending: {},
    sources: ["notion_search"],
  });
  const bob = read(admitted(holding, "bob"), "call-2", "slack_search_dms");
  assert.deepEqual(bob.owners, ["alice", "bob"]);
  assert.deepEqual(bob.sources, ["notion_search", "slack_search_dms"]);
  // A delivery with no principal, such as a sign-in callback, keeps the caller.
  assert.equal(admitted(bob, undefined).caller, "bob");
});

test("reads personal data from tagged entries and the untagged built-in agent tool", () => {
  assert.equal(readsPersonal({ name: "notion_search", tags: ["reads:personal"] }), true);
  assert.equal(readsPersonal({ name: "agent" }), true);
  assert.equal(readsPersonal({ name: "agent", tags: [] }), false);
  assert.equal(readsPersonal({ name: "web_fetch" }), false);
});

test("records nothing for a personal read that didn't complete", () => {
  for (const outcome of ["failed", "rejected", "interrupted"]) {
    assert.deepEqual(read(initialPersonalContext(), "call-1", "notion_search", outcome), {
      ...initialPersonalContext(),
    });
  }
});

test("owns a read with no known caller as unknown, and caps deduplicated sources", () => {
  assert.deepEqual(read(initialPersonalContext(), "call-1", "notion_search").owners, ["unknown"]);
  let state = initialPersonalContext();
  for (let index = 0; index < MAX_SOURCES + 3; index++) {
    state = read(state, `call-${index}`, `tool_${index}`);
  }
  state = read(state, "again", "tool_5");
  assert.equal(state.sources.length, MAX_SOURCES);
  assert.equal(state.sources.at(-1), "tool_5");
  assert.equal(state.sources.filter((source) => source === "tool_5").length, 1);
});

test("asks before writes only once the session holds personal data", () => {
  for (const toolTags of [["effect:external"], ["effect:export"]]) {
    assert.equal(
      decidePrivateContext(initialPersonalContext(), { toolName: "x", toolTags }),
      undefined,
    );
    assert.equal(decidePrivateContext(holding, { toolName: "x", toolTags }), "user-approval");
  }
  assert.equal(decidePrivateContext(holding, { toolName: "x", toolTags: [] }), undefined);
  assert.equal(decidePrivateContext(holding, { toolName: "local_tool" }), undefined);
});

test("treats untagged connection tools as writes by default, unless read-only", () => {
  const write = { toolName: "linear__create_issue" };
  assert.equal(decidePrivateContext(holding, write), "user-approval");
  assert.equal(decidePrivateContext(holding, write, { untaggedConnections: "ignore" }), undefined);
  assert.equal(
    decidePrivateContext(holding, { toolAnnotations: { readOnlyHint: true }, toolName: "list" }),
    undefined,
  );
  assert.equal(decidePrivateContext(holding, { toolName: "eve__search" }), undefined);
});

test("denies personal reads unless the conversation is private", () => {
  const call = { toolName: "notion_search", toolTags: ["reads:personal"] };
  const denied = { reason: AUDIENCE_DENIED_REASON, type: "denied" };
  assert.deepEqual(decideAudience("public", call), denied);
  assert.deepEqual(decideAudience("unknown", call), denied);
  assert.equal(decideAudience("private", call), undefined);
  assert.equal(decideAudience("unknown", call, { treatUnknownAs: "private" }), undefined);
  assert.deepEqual(decideAudience("public", call, { treatUnknownAs: "private" }), denied);
  assert.equal(
    decideAudience("public", { toolName: "post", toolTags: ["effect:external"] }),
    undefined,
  );
});

test("keeps the strictest status, and the first of equals", () => {
  const first = { reason: "first", type: "denied" } as const;
  assert.equal(strictestOf([undefined, "user-approval", first, "denied"]), first);
  assert.equal(strictestOf([undefined, "approved", "user-approval"]), "user-approval");
  assert.equal(strictestOf([false, "user-approval"]), false);
  assert.equal(strictestOf([undefined, true]), true);
  assert.equal(strictestOf(["not-applicable", undefined]), undefined);
  assert.equal(strictestOf([]), undefined);
});
