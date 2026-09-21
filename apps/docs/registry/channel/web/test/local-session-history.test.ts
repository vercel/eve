import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalSessionHistory } from "../lib/local-session-history.ts";

test("local history remembers only observed sessions and survives reload", () => {
  let value: string | null = null;
  const disk = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
  const store = createLocalSessionHistory(disk);
  assert.equal(store.load().sessions.length, 0);
  store.record("wrun_A", {
    type: "message.received",
    meta: { id: "a", at: "2026-09-01T00:00:00Z" },
    data: { message: "First", sequence: 1, turnId: "turn" },
  });
  store.record("wrun_B", {
    type: "message.received",
    meta: { id: "b", at: "2026-09-02T00:00:00Z" },
    data: { message: "Second", sequence: 1, turnId: "turn" },
  });
  store.record("wrun_A", {
    type: "message.received",
    meta: { id: "c", at: "2026-09-03T00:00:00Z" },
    data: { message: "Later", sequence: 2, turnId: "turn2" },
  });
  store.flush();
  const restored = createLocalSessionHistory(disk).load().sessions;
  assert.deepEqual(
    restored.map((s) => s.id),
    ["wrun_A", "wrun_B"],
  );
  assert.equal(restored[0].title, "First");
});
