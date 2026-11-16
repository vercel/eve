import assert from "node:assert/strict";
import { test } from "node:test";
import typefully from "../agent/subagents/social-media-coordinator/connections/typefully.ts";

for (const [name, tool, requestBody, expected] of [
  [
    "content-only edits require approval even when the existing schedule is omitted",
    "edit_draft",
    { platforms: { x: { posts: [{ text: "Updated campaign copy" }] } } },
    "user-approval",
  ],
  [
    "edits require approval even when explicitly clearing the schedule",
    "edit_draft",
    { plan_at: null, publish_at: null },
    "user-approval",
  ],
  [
    "creating a plain draft remains ungated",
    "create_draft",
    { platforms: { x: { posts: [{ text: "New campaign draft" }] } } },
    "not-applicable",
  ],
  [
    "creating a scheduled draft requires approval",
    "create_draft",
    { publish_at: "2027-01-01T12:00:00Z" },
    "user-approval",
  ],
  [
    "creating a planned draft requires approval",
    "create_draft",
    { plan_at: "next-free-slot" },
    "user-approval",
  ],
  [
    "unrecognized create input fails closed",
    "create_draft",
    undefined,
    "user-approval",
  ],
  [
    "deleting a draft still requires approval",
    "delete_draft",
    {},
    "user-approval",
  ],
  ["reading a draft remains ungated", "get_draft", {}, "not-applicable"],
]) {
  test(name, async () => {
    assert.ok(typefully.tools.allow.includes(tool));
    assert.equal(
      await typefully.approval({
        toolInput: {
          draft_id: 2,
          social_set_id: 1,
          ...(requestBody === undefined ? {} : { requestBody }),
        },
        toolName: `typefully__${tool}`,
      }),
      expected
    );
  });
}
