import assert from "node:assert/strict";
import test from "node:test";

import {
  admitted,
  decideAudience,
  decidePrivateContext,
  exceeded,
  initialPersonalContext,
  MAX_SOURCES,
  PERSONAL_AUDIENCE_REASON,
  readLevelOf,
  requested,
  SENSITIVE_AUDIENCE_REASON,
  settled,
  sinkCapOf,
  strictestOf,
  type PersonalContext,
  type ReadLevel,
} from "../../extension/lib/private-context.ts";

function read(
  state: PersonalContext,
  callId: string,
  name: string,
  level: ReadLevel = "personal",
  outcome = "completed",
) {
  return settled(requested(state, callId, name, level), callId, outcome);
}

const alice = admitted(initialPersonalContext(), "alice");
const personal = read(alice, "call-1", "notion_search");
const sensitive = read(alice, "call-1", "wiki_search", "sensitive");

const sink = (...toolTags: string[]) => ({ toolName: "send", toolTags });

test("records the caller as the owner of a completed personal read", () => {
  assert.deepEqual(personal, {
    ...alice,
    owners: ["alice"],
    sources: ["notion_search"],
  });
  const bob = read(admitted(personal, "bob"), "call-2", "slack_search_dms");
  assert.deepEqual(bob.owners, ["alice", "bob"]);
  assert.deepEqual(bob.sources, ["notion_search", "slack_search_dms"]);
  // A delivery with no principal, such as a sign-in callback, keeps the caller.
  assert.equal(admitted(bob, undefined).caller, "bob");
});

test("records a sensitive read without an owner", () => {
  assert.deepEqual(sensitive, { ...alice, sensitive: true, sensitiveSources: ["wiki_search"] });
});

test("records nothing for a read that didn't complete", () => {
  for (const outcome of ["failed", "rejected", "interrupted"]) {
    assert.deepEqual(read(alice, "call-1", "notion_search", "personal", outcome), alice);
  }
});

test("owns a read with no known caller as unknown, and caps deduplicated sources", () => {
  assert.deepEqual(read(initialPersonalContext(), "call-1", "x").owners, ["unknown"]);
  let state = initialPersonalContext();
  for (let index = 0; index < MAX_SOURCES + 3; index++) {
    state = read(state, `call-${index}`, `tool_${index}`);
  }
  state = read(state, "again", "tool_5");
  assert.equal(state.sources.length, MAX_SOURCES);
  assert.equal(state.sources.at(-1), "tool_5");
  assert.equal(state.sources.filter((source) => source === "tool_5").length, 1);
});

test("orders read levels from tags, and counts the untagged agent tool as personal", () => {
  assert.equal(readLevelOf({ name: "x", tags: ["reads:sensitive"] }), "sensitive");
  assert.equal(readLevelOf({ name: "x", tags: ["reads:sensitive", "reads:personal"] }), "personal");
  assert.equal(readLevelOf({ name: "agent" }), "personal");
  assert.equal(readLevelOf({ name: "agent", tags: [] }), undefined);
  assert.equal(readLevelOf({ name: "web_fetch" }), undefined);
});

test("caps sinks by their sink tag, and any other external call at public", () => {
  assert.equal(sinkCapOf(sink("sink:internal")), "internal");
  assert.equal(sinkCapOf(sink("effect:external", "sink:user")), "user");
  assert.equal(sinkCapOf(sink("effect:external")), "public");
  assert.equal(sinkCapOf(sink("effect:irreversible")), "public");
  assert.equal(sinkCapOf(sink()), undefined);
  assert.equal(sinkCapOf({ toolName: "linear__create_issue" }), "public");
  assert.equal(
    sinkCapOf({ toolName: "linear__create_issue" }, { untaggedConnections: "ignore" }),
    undefined,
  );
  assert.equal(sinkCapOf({ toolAnnotations: { readOnlyHint: true }, toolName: "list" }), undefined);
  assert.equal(sinkCapOf({ toolName: "eve__search" }), undefined);
  assert.equal(sinkCapOf({ toolName: "local_tool" }), undefined);
});

test("lets personal data go only back to its owner", () => {
  assert.equal(exceeded(personal, sink("sink:user"), "alice"), undefined);
  assert.equal(exceeded(personal, sink("sink:user"), "bob"), "personal");
  assert.equal(exceeded(personal, sink("sink:internal"), "alice"), "personal");
  assert.equal(exceeded(personal, sink("effect:external"), "alice"), "personal");
  const shared = read(admitted(personal, "bob"), "call-2", "slack_search_dms");
  assert.equal(exceeded(shared, sink("sink:user"), "bob"), "personal");
});

test("lets sensitive data go to internal and user sinks, not public ones", () => {
  assert.equal(exceeded(sensitive, sink("sink:internal"), "alice"), undefined);
  assert.equal(exceeded(sensitive, sink("sink:user"), "alice"), undefined);
  assert.equal(exceeded(sensitive, sink("sink:public"), "alice"), "sensitive");
  assert.equal(exceeded(sensitive, sink("effect:external"), "alice"), "sensitive");
  assert.equal(exceeded(alice, sink("sink:public"), "alice"), undefined);
});

test("asks for personal flows always, and sensitive flows unless allowed", () => {
  assert.equal(decidePrivateContext(personal, sink("sink:internal"), "alice"), "user-approval");
  assert.equal(
    decidePrivateContext(personal, sink("sink:internal"), "alice", { sensitiveFlows: "allow" }),
    "user-approval",
  );
  assert.equal(decidePrivateContext(sensitive, sink("sink:public"), "alice"), "user-approval");
  assert.equal(
    decidePrivateContext(sensitive, sink("sink:public"), "alice", { sensitiveFlows: "allow" }),
    undefined,
  );
  assert.equal(decidePrivateContext(personal, sink("sink:user"), "alice"), undefined);
  assert.equal(decidePrivateContext(alice, sink("effect:external"), "alice"), undefined);
});

test("denies reads by what the conversation's readers may see", () => {
  const personalRead = { toolName: "notion_search", toolTags: ["reads:personal"] };
  const sensitiveRead = { toolName: "wiki_search", toolTags: ["reads:sensitive"] };
  const personalDenied = { reason: PERSONAL_AUDIENCE_REASON, type: "denied" };
  const sensitiveDenied = { reason: SENSITIVE_AUDIENCE_REASON, type: "denied" };
  assert.equal(decideAudience("private", personalRead), undefined);
  assert.equal(decideAudience("private", sensitiveRead), undefined);
  // eve's public is the workspace: sensitive data may be read there, personal data may not.
  assert.deepEqual(decideAudience("public", personalRead), personalDenied);
  assert.equal(decideAudience("public", sensitiveRead), undefined);
  assert.deepEqual(decideAudience("unknown", personalRead), personalDenied);
  assert.deepEqual(decideAudience("unknown", sensitiveRead), sensitiveDenied);
  assert.equal(decideAudience("unknown", sensitiveRead, { treatUnknownAs: "internal" }), undefined);
  assert.equal(decideAudience("unknown", personalRead, { treatUnknownAs: "private" }), undefined);
  assert.equal(decideAudience("public", sink("effect:external")), undefined);
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
