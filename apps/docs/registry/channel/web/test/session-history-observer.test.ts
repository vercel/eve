import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionHistoryObserver } from "../lib/session-history-observer.ts";
import { createSessionStore } from "../lib/session-store.ts";
import { eveChannel } from "eve/channels/eve";

test("the HTTP eve channel projects root messages without joining turn completion", async () => {
  const writes: unknown[][] = [],
    pending: Promise<void>[] = [],
    errors: unknown[] = [];
  let fail = false;
  const store = createSessionStore(async (_sql, values) => {
    writes.push(values);
    if (fail) throw new Error("offline");
    return [{ session_id: "root" }];
  }, "app");
  const observe = createSessionHistoryObserver(
    () => store,
    (work) => pending.push(work),
    (error) => errors.push(error),
  );
  const channel = eveChannel({ auth: [] });
  const ctx = {
    channel: { kind: Reflect.get(channel, "adapter").kind },
    session: { id: "root" },
  };
  assert.equal(ctx.channel.kind, "http");
  const event = {
    type: "message.received" as const,
    meta: { id: "m", at: "2026-09-21T00:00:00Z" },
    data: { message: "A title", turnId: "turn", sequence: 1 },
  };
  assert.equal(observe(event, ctx), undefined);
  assert.equal(writes.length, 0);
  await Promise.all(pending);
  assert.equal(writes[0][2], "A title");
  fail = true;
  assert.equal(observe(event, ctx), undefined);
  await Promise.all(pending);
  assert.equal(errors.length, 1);
});

test("nested child projection uses durable root lineage without authentication attributes", async () => {
  const writes: unknown[][] = [],
    pending: Promise<void>[] = [];
  const store = createSessionStore(async (_sql, values) => {
    writes.push(values);
    return [];
  }, "app");
  const observe = createSessionHistoryObserver(
    () => store,
    (work) => pending.push(work),
  );
  observe(
    {
      type: "subagent.called",
      meta: { id: "call-event", at: "2026-09-21T00:00:00Z" },
      data: {
        sessionId: "child",
        callId: "nested-call",
        childSessionId: "grandchild",
        childStreamPath: "/eve/v1/session/grandchild/stream",
        name: "worker",
        toolName: "worker",
        turnId: "turn",
        sequence: 1,
        workflowId: "workflow",
      },
    },
    { session: { id: "child", parent: { rootSessionId: "root" } } },
  );
  await Promise.all(pending);
  assert.deepEqual(writes, [["app", "root", "child", "nested-call", "grandchild"]]);
});
