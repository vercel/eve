import assert from "node:assert/strict";
import { test } from "node:test";
import { paginateSessions, parseSessionPageQuery } from "../lib/session-pagination.ts";

test("cursor pages preserve last-message order and tied timestamps without overlap", () => {
  const sessions = ["C", "A", "B"].map((id) => ({
    id: `wrun_${id}`,
    title: id,
    createdAt: "2026-09-20T00:00:00.000Z",
  }));
  sessions.push({ id: "wrun_OLD", title: "Old", createdAt: "2026-09-19T00:00:00.000Z" });
  const active = { ...sessions[3], lastMessageAt: "2026-09-21T00:00:00.000Z" };
  const all = [...sessions.slice(0, 3), active];
  const first = paginateSessions(all, { limit: 2 });
  assert.deepEqual(
    first.sessions.map((s) => s.id),
    ["wrun_OLD", "wrun_A"],
  );
  const second = paginateSessions(
    all,
    parseSessionPageQuery(
      new URL(`https://example.test/api/sessions?limit=2&cursor=${first.nextCursor}`),
    ),
  );
  assert.deepEqual(
    second.sessions.map((s) => s.id),
    ["wrun_B", "wrun_C"],
  );
  assert.equal(second.nextCursor, undefined);
});

test("rejects invalid cursors and unbounded page sizes", () => {
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=NaN",
    "limit=1.5",
    "cursor=garbage",
    "cursor=../../secret",
  ]) {
    assert.throws(() => parseSessionPageQuery(new URL(`https://example.test/?${query}`)));
  }
  assert.deepEqual(parseSessionPageQuery(new URL("https://example.test/")), { limit: 30 });
});
