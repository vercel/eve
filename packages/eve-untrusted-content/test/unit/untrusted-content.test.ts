import assert from "node:assert/strict";
import test from "node:test";

import type { ApprovalStatus } from "eve/tools/approval";

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
} from "../../extension/lib/untrusted-content.ts";

const typeOf = (status: ApprovalStatus) => (typeof status === "object" ? status.type : status);

const exposed: Exposure = expose(initialExposure(), "read_issue");

const publish = { toolName: "share_doc", toolTags: ["effect:irreversible", "sink:public"] };
const deleteRepo = { toolName: "delete_repo", toolTags: ["effect:irreversible"] };

test("leaves every call alone until the session is exposed", () => {
  for (const toolTags of [["effect:external"], ["effect:irreversible", "sink:public"], undefined]) {
    assert.equal(decide(initialExposure(), { toolName: "send_email", toolTags }), undefined);
  }
});

test("denies publishing with the sources, and asks before external and irreversible calls", () => {
  assert.deepEqual(decide(exposed, publish), {
    reason:
      "This session read untrusted content from read_issue, so `share_doc` can't publish data. Finish without publishing, or ask the user to publish it themselves.",
    type: "denied",
  });
  assert.equal(typeOf(decide(exposed, publish, { onPublish: "user-approval" })), "user-approval");
  assert.equal(
    typeOf(decide(exposed, { toolName: "send_email", toolTags: ["effect:external"] })),
    "user-approval",
  );
  assert.equal(typeOf(decide(exposed, deleteRepo)), "user-approval");
  // A public sink that isn't irreversible is an ordinary external call.
  assert.equal(
    typeOf(decide(exposed, { toolName: "post", toolTags: ["effect:external", "sink:public"] })),
    "user-approval",
  );
  assert.equal(decide(exposed, { toolName: "list_labels", toolTags: [] }), undefined);
});

test("tells the approver which untrusted sources it read", () => {
  assert.deepEqual(decide(exposed, deleteRepo), {
    reason:
      "This session read untrusted content from read_issue, which could be steering this call.",
    type: "user-approval",
  });
});

test("still asks before irreversible calls when `when` doesn't match, and nothing else", () => {
  assert.equal(typeOf(decide(exposed, deleteRepo, {}, false)), "user-approval");
  assert.equal(typeOf(decide(exposed, publish, {}, false)), "user-approval");
  assert.equal(
    decide(exposed, { toolName: "post", toolTags: ["effect:external"] }, {}, false),
    undefined,
  );
  assert.equal(
    decide(
      exposed,
      { toolName: "linear__create" },
      { untaggedConnections: "treat-as-external" },
      false,
    ),
    undefined,
  );
});

test("treats untagged connection tools as external only when asked, unless read-only", () => {
  const options = { untaggedConnections: "treat-as-external" as const };
  const write = { toolName: "linear__create_issue" };
  assert.equal(decide(exposed, write), undefined);
  assert.equal(typeOf(decide(exposed, write, options)), "user-approval");
  assert.equal(
    decide(
      exposed,
      { toolAnnotations: { readOnlyHint: true }, toolName: "linear__list_issues" },
      options,
    ),
    undefined,
  );
  // A destructive hint makes it irreversible, which `when` can't wave through.
  assert.equal(
    typeOf(
      decide(
        exposed,
        { toolAnnotations: { destructiveHint: true }, toolName: "drop" },
        options,
        false,
      ),
    ),
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
    "untrusted.exposed": true,
    "untrusted.sources": "read_issue",
  });
  const long = expose(exposed, "x".repeat(400));
  assert.equal(runtimeContextOf(long)["untrusted.sources"].length, 256);
});
