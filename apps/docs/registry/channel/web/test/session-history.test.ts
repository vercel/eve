import assert from "node:assert/strict";
import { test } from "node:test";
import { applySessionActivity, sortSessions } from "../lib/session-history.ts";

test("message activity excludes tools and turn bookkeeping and ignores replayed events", () => {
  let activity = applySessionActivity(
    {},
    { type: "turn.started", meta: { at: "2026-09-19T10:00:00Z" } },
  );
  activity = applySessionActivity(activity, {
    type: "message.received",
    meta: { at: "2026-09-19T10:01:00Z" },
  });
  activity = applySessionActivity(activity, {
    type: "message.completed",
    meta: { at: "2026-09-19T10:02:00Z" },
  });
  for (const type of ["action.result", "turn.completed", "session.waiting"]) {
    assert.equal(
      applySessionActivity(activity, { type, meta: { at: "2026-09-20T10:00:00Z" } }),
      activity,
    );
  }
  assert.equal(
    applySessionActivity(activity, {
      type: "message.received",
      meta: { at: "2026-09-18T10:00:00Z" },
    }),
    activity,
  );
  assert.equal(
    applySessionActivity(activity, { type: "message.received", meta: { at: "invalid" } }),
    activity,
  );
  assert.deepEqual(activity, {
    lastTurnAt: "2026-09-19T10:00:00Z",
    lastMessageAt: "2026-09-19T10:02:00Z",
  });
});

test("continued older conversations sort above newer idle conversations", () => {
  const newer = { id: "new", title: "New", createdAt: "2026-09-20T10:00:00Z" };
  const older = {
    id: "old",
    title: "Old",
    createdAt: "2026-09-19T10:00:00Z",
    lastMessageAt: "2026-09-21T10:00:00Z",
  };
  assert.deepEqual(sortSessions([newer, older]), [older, newer]);
});
