import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createSessionStore } from "../lib/session-store.ts";
import { parseSessionPageQuery } from "../lib/session-pagination.ts";

test("production index isolates owners and environments, paginates activity, and tolerates replay", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL("../db/session-index.sql", import.meta.url), "utf8"));
    const query = async (sql: string, values: unknown[]) =>
      (await db.query<Record<string, unknown>>(sql, values)).rows;
    const store = createSessionStore(query, "production");
    const preview = createSessionStore(query, "preview");
    const early = "2026-09-01T00:00:00.000Z",
      late = "2026-09-20T00:00:00.000Z";
    const a = {
      id: "wrun_A",
      ownerKey: "alice",
      title: "First message",
      titleAt: early,
      createdAt: early,
      lastMessageAt: early,
    };
    await store.record(a);
    await store.record({ ...a, id: "wrun_B", createdAt: late, lastMessageAt: late });
    await store.record({ ...a, id: "wrun_C", ownerKey: "bob" });
    await preview.record({ ...a, id: "wrun_P" });
    await store.record({
      ...a,
      title: "Later message",
      titleAt: late,
      lastMessageAt: late,
      lastTurnAt: late,
    });
    await store.record(a);
    await assert.rejects(store.record({ ...a, ownerKey: "bob" }), /ownership conflict/);
    assert.equal(await store.owns("bob", "wrun_A"), false);
    assert.equal(await store.owns("alice", "wrun_missing"), false);
    assert.equal(await store.owns("alice", "wrun_P"), false);
    // A nested call may be projected before its parent's background write.
    await store.recordChild("wrun_A", "child", "nested-call", "grandchild");
    await store.recordChild("wrun_A", "wrun_A", "call", "child");
    await store.recordChild("wrun_A", "wrun_A", "call", "child");
    assert.equal(await store.ownsChild("alice", "wrun_A", "call", "child"), true);
    assert.equal(await store.ownsChild("alice", "child", "nested-call", "grandchild"), true);
    assert.equal(await store.ownsChild("bob", "wrun_A", "call", "child"), false);
    assert.equal(await store.ownsChild("alice", "wrun_A", "other-call", "child"), false);
    assert.equal(await preview.ownsChild("alice", "wrun_A", "call", "child"), false);
    // Child ownership comes from stored root session state, never caller-provided auth attributes.
    await store.recordChild("missing", "missing", "call", "unowned");
    assert.equal(await store.ownsChild("alice", "missing", "call", "unowned"), false);
    await preview.recordChild("wrun_A", "wrun_A", "call", "child");
    assert.equal(await preview.ownsChild("alice", "wrun_A", "call", "child"), false);
    await store.update({ id: "unindexed", title: "Hidden", lastMessageAt: late });
    assert.equal(
      (await db.query("SELECT 1 FROM web_sessions WHERE session_id = 'unindexed'")).rows.length,
      0,
    );
    await store.update({
      id: "wrun_A",
      title: "Ignored later title",
      titleAt: late,
      lastMessageAt: late,
      lastTurnAt: late,
    });
    const first = await store.list("alice", { limit: 1 });
    assert.equal(first.sessions[0].id, "wrun_A");
    assert.equal(first.sessions[0].title, "First message");
    assert.equal(first.sessions[0].createdAt, early);
    assert.equal(first.sessions[0].lastMessageAt, late);
    assert.equal(first.sessions[0].lastTurnAt, late);
    const second = await store.list(
      "alice",
      parseSessionPageQuery(new URL(`https://example.com/?limit=1&cursor=${first.nextCursor}`)),
    );
    assert.deepEqual(
      second.sessions.map((s) => s.id),
      ["wrun_B"],
    );
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(
      (await store.list("bob", { limit: 30 })).sessions.map((s) => s.id),
      ["wrun_C"],
    );
    await Promise.all([
      store.record({ ...a, lastMessageAt: "2026-09-21T00:00:00.000Z" }),
      store.record(a),
    ]);
    assert.equal(
      (await store.list("alice", { limit: 30 })).sessions[0].lastMessageAt,
      "2026-09-21T00:00:00.000Z",
    );
  } finally {
    await db.close();
  }
});
