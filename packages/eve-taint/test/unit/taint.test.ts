import assert from "node:assert/strict";
import test from "node:test";

import {
  decide,
  expose,
  initialExposure,
  MAX_SOURCES,
  readsOf,
  requested,
  runtimeContextOf,
  settled,
  type Exposure,
} from "../../extension/lib/taint.ts";

const untrusted: Exposure = expose(initialExposure(), "untrusted", "read_issue");
const sensitive: Exposure = expose(initialExposure(), "sensitive", "read_notes");
const both: Exposure = expose(untrusted, "sensitive", "read_notes");

const external = { toolName: "send_email", toolTags: ["effect:external"] };
const exportCall = { toolName: "share_doc", toolTags: ["effect:export"] };

test("leaves effects alone until untrusted content and sensitive data meet", () => {
  for (const state of [initialExposure(), untrusted, sensitive]) {
    assert.equal(decide(state, external), undefined);
    assert.equal(decide(state, exportCall), undefined);
  }
});

test("denies an export with both legs' sources, and asks before an external effect", () => {
  assert.deepEqual(decide(both, exportCall), {
    reason:
      "This session read untrusted content from read_issue and sensitive data from read_notes, so `share_doc` can't export data. Finish without exporting, or ask the user to export it themselves.",
    type: "denied",
  });
  assert.equal(decide(both, external), "user-approval");
  assert.equal(decide(both, { toolName: "list_labels", toolTags: [] }), undefined);
});

test("counts a call that acts on a sensitive system as the sensitive leg", () => {
  const deleteRepo = { toolName: "delete_repo", toolTags: ["effect:external", "effect:sensitive"] };
  assert.equal(decide(untrusted, deleteRepo), "user-approval");
  assert.equal(decide(initialExposure(), deleteRepo), undefined);
  const exportBilling = {
    toolName: "export_billing",
    toolTags: ["effect:export", "effect:sensitive"],
  };
  assert.match(
    (decide(untrusted, exportBilling) as { reason: string }).reason,
    /read_issue, and `export_billing` acts on a sensitive system/u,
  );
});

test("asks on untrusted content alone with assumeSensitive", () => {
  assert.equal(decide(untrusted, external, { assumeSensitive: true }), "user-approval");
  assert.equal(decide(sensitive, external, { assumeSensitive: true }), undefined);
});

test("honors custom tags and asking before exports", () => {
  const options = {
    exportTag: "x:export",
    externalTag: "x:send",
    onExport: "user-approval" as const,
  };
  assert.equal(decide(both, { toolName: "a", toolTags: ["x:export"] }, options), "user-approval");
  assert.equal(decide(both, { toolName: "b", toolTags: ["x:send"] }, options), "user-approval");
  assert.equal(decide(both, { toolName: "c", toolTags: ["effect:export"] }, options), undefined);
});

test("treats untagged connection tools as external only when asked, unless read-only", () => {
  const options = { untaggedConnections: "treat-as-external" as const };
  const write = { toolName: "linear__create_issue" };
  assert.equal(decide(both, write), undefined);
  assert.equal(decide(both, write, options), "user-approval");
  assert.equal(
    decide(both, { toolAnnotations: { readOnlyHint: true }, toolName: "linear__list" }, options),
    undefined,
  );
  assert.equal(
    decide(both, { toolAnnotations: { destructiveHint: true }, toolName: "drop" }, options),
    "user-approval",
  );
  assert.equal(decide(both, { toolName: "local_tool" }, options), undefined);
  assert.equal(decide(both, { toolName: "eve__search" }, options), undefined);
  assert.equal(decide(both, { toolName: "linear__x", toolTags: [] }, options), undefined);
});

test("reads legs from tags, and from untagged built-ins by name", () => {
  assert.deepEqual(readsOf({ name: "read_issue", tags: ["reads:untrusted"] }), ["untrusted"]);
  assert.deepEqual(readsOf({ name: "read_notes", tags: ["reads:sensitive"] }), ["sensitive"]);
  assert.deepEqual(readsOf({ name: "notion_search", tags: ["reads:personal"] }), ["sensitive"]);
  for (const name of ["bash", "web_fetch", "web_search"]) {
    assert.deepEqual(readsOf({ name }), ["untrusted"], name);
  }
  assert.deepEqual(readsOf({ name: "agent" }), ["untrusted", "sensitive"]);
  assert.deepEqual(readsOf({ name: "read_file" }), []);
  // An authored tool that takes a built-in's name is judged by its own tags.
  assert.deepEqual(readsOf({ name: "bash", tags: [] }), []);
});

test("records a read's legs on settle unless the call was rejected", () => {
  const pending = requested(initialExposure(), "call-1", "agent", ["untrusted", "sensitive"]);
  assert.deepEqual(settled(pending, "call-1", "rejected"), initialExposure());
  for (const outcome of ["completed", "failed", "interrupted"]) {
    assert.deepEqual(settled(pending, "call-1", outcome), {
      exposed: true,
      pending: {},
      sensitive: true,
      sensitiveSources: ["agent"],
      sources: ["agent"],
    });
  }
  assert.equal(settled(pending, "call-2", "completed"), pending);
});

test("dedupes sources, keeps the newest, and caps them", () => {
  let state = initialExposure();
  for (let index = 0; index < MAX_SOURCES + 5; index++) {
    state = expose(state, "untrusted", `tool_${index}`);
  }
  state = expose(state, "untrusted", "tool_10");
  assert.equal(state.sources.length, MAX_SOURCES);
  assert.equal(state.sources.at(-1), "tool_10");
  assert.equal(state.sources.filter((source) => source === "tool_10").length, 1);
  assert.equal(state.sources.includes("tool_0"), false);
  assert.deepEqual(state.sensitiveSources, []);
});

test("reports both legs as span attributes, truncating long sources", () => {
  assert.deepEqual(runtimeContextOf(both), {
    "taint.exposed": true,
    "taint.sensitive": true,
    "taint.sensitive_sources": "read_notes",
    "taint.sources": "read_issue",
  });
  const long = expose(both, "untrusted", "x".repeat(400));
  assert.equal(runtimeContextOf(long)["taint.sources"].length, 256);
});
