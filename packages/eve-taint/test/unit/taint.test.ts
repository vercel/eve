import assert from "node:assert/strict";
import test from "node:test";

import {
  decide,
  expose,
  initialExposure,
  MAX_SOURCES,
  readsUntrusted,
  requested,
  runtimeContextOf,
  settled,
  type Exposure,
} from "../../extension/lib/taint.ts";

const exposed: Exposure = expose(initialExposure(), "read_issue");

test("leaves every call alone until the session is exposed", () => {
  for (const toolTags of [["effect:export"], ["effect:external"], undefined]) {
    assert.equal(decide(initialExposure(), { toolName: "send_email", toolTags }), undefined);
  }
});

test("denies an export with the sources, and asks before an external effect", () => {
  assert.deepEqual(decide(exposed, { toolName: "share_doc", toolTags: ["effect:export"] }), {
    reason:
      "This session read untrusted content from read_issue, so `share_doc` can't export data. Finish without exporting, or ask the user to export it themselves.",
    type: "denied",
  });
  assert.equal(
    decide(exposed, { toolName: "send_email", toolTags: ["effect:external"] }),
    "user-approval",
  );
  assert.equal(decide(exposed, { toolName: "list_labels", toolTags: [] }), undefined);
});

test("honors custom tags and asking before exports", () => {
  const options = {
    exportTag: "x:export",
    externalTag: "x:send",
    onExport: "user-approval" as const,
  };
  assert.equal(
    decide(exposed, { toolName: "a", toolTags: ["x:export"] }, options),
    "user-approval",
  );
  assert.equal(decide(exposed, { toolName: "b", toolTags: ["x:send"] }, options), "user-approval");
  assert.equal(decide(exposed, { toolName: "c", toolTags: ["effect:export"] }, options), undefined);
});

test("treats untagged connection tools as external only when asked, unless read-only", () => {
  const options = { untaggedConnections: "treat-as-external" as const };
  const write = { toolName: "linear__create_issue" };
  assert.equal(decide(exposed, write), undefined);
  assert.equal(decide(exposed, write, options), "user-approval");
  assert.equal(
    decide(
      exposed,
      { toolAnnotations: { readOnlyHint: true }, toolName: "linear__list_issues" },
      options,
    ),
    undefined,
  );
  assert.equal(
    decide(exposed, { toolAnnotations: { destructiveHint: true }, toolName: "drop" }, options),
    "user-approval",
  );
  assert.equal(decide(exposed, { toolName: "local_tool" }, options), undefined);
  assert.equal(decide(exposed, { toolName: "eve__search" }, options), undefined);
  // A tagged connection tool is decided by its tags alone.
  assert.equal(decide(exposed, { toolName: "linear__x", toolTags: [] }, options), undefined);
});

test("reads untrusted content from tagged entries and from untagged built-ins by name", () => {
  assert.equal(readsUntrusted({ name: "read_issue", tags: ["reads:untrusted"] }), true);
  for (const name of ["agent", "bash", "web_fetch", "web_search"]) {
    assert.equal(readsUntrusted({ name }), true, name);
  }
  assert.equal(readsUntrusted({ name: "read_file" }), false);
  // An authored tool that takes a built-in's name is judged by its own tags.
  assert.equal(readsUntrusted({ name: "bash", tags: [] }), false);
});

test("exposes on settle unless the call was rejected", () => {
  const pending = requested(initialExposure(), "call-1", "read_issue");
  assert.deepEqual(settled(pending, "call-1", "rejected"), initialExposure());
  for (const outcome of ["completed", "failed", "interrupted"]) {
    assert.deepEqual(settled(pending, "call-1", outcome), {
      exposed: true,
      pending: {},
      sources: ["read_issue"],
    });
  }
  assert.equal(settled(pending, "call-2", "completed"), pending);
});

test("dedupes sources, keeps the newest, and caps them", () => {
  let state = initialExposure();
  for (let index = 0; index < MAX_SOURCES + 5; index++) state = expose(state, `tool_${index}`);
  state = expose(state, "tool_10");
  assert.equal(state.sources.length, MAX_SOURCES);
  assert.equal(state.sources.at(-1), "tool_10");
  assert.equal(state.sources.filter((source) => source === "tool_10").length, 1);
  assert.equal(state.sources.includes("tool_0"), false);
});

test("truncates the sources span attribute", () => {
  assert.deepEqual(runtimeContextOf(exposed), {
    "taint.exposed": true,
    "taint.sources": "read_issue",
  });
  const long = expose(exposed, "x".repeat(400));
  assert.equal(runtimeContextOf(long)["taint.sources"].length, 256);
});
