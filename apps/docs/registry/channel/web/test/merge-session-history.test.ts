import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSessionHistory } from "../lib/merge-session-history.ts";
import type { SessionHistory } from "../lib/session-history.ts";
const viewer = { id: "alice", name: "Alice", source: "user" as const };
const a = { id: "wrun_A", title: "A", createdAt: "2026-09-01T00:00:00Z" };
test("refresh retains loaded rows and live activity but restarts the cursor", () => {
  const current: SessionHistory = {
    viewer,
    sessions: [
      { ...a, lastMessageAt: "2026-09-20T00:00:00Z" },
      { ...a, id: "wrun_B" },
    ],
    nextCursor: "old",
  };
  const incoming: SessionHistory = { viewer, sessions: [a], nextCursor: "fresh" };
  const merged = mergeSessionHistory(current, incoming);
  assert.deepEqual(
    merged.sessions.map((s) => s.id),
    ["wrun_A", "wrun_B"],
  );
  assert.equal(merged.sessions[0].lastMessageAt, "2026-09-20T00:00:00Z");
  assert.equal(merged.nextCursor, "fresh");
  assert.equal(mergeSessionHistory(merged, incoming).sessions.length, 2);
});
test("changing identity never merges another user's sessions", () => {
  const next: SessionHistory = { viewer: { ...viewer, id: "bob" }, sessions: [] };
  assert.deepEqual(mergeSessionHistory({ viewer, sessions: [a] }, next), next);
});
