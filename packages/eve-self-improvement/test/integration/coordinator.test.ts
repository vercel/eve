import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { emptySessionView, foldEvents, type ReceivedEvent } from "eve/events";
import { config, experiment } from "./fixtures.js";
import type { Active, Experiment } from "../../extension/lib/types.js";

let active: Active;
let progress = { turnId: "", calls: [] as { name: string; state: string; output?: string }[] };
mock.module("eve/context", {
  exports: {
    defineState: () => ({
      get: () => progress,
      update: (update: (value: typeof progress) => typeof progress) => {
        progress = update(progress);
      },
    }),
  },
});
mock.module("../../extension/extension.js", { exports: { default: { config: config() } } });
mock.module("../../extension/lib/store.js", {
  exports: {
    store: () => ({
      async active() {
        return structuredClone(active);
      },
      async renew() {},
      async bindSession() {
        return structuredClone(active.experiment);
      },
      async save(_lease: unknown, value: Experiment | null) {
        active.experiment = structuredClone(value);
      },
    }),
  },
});
const step = (await import("../../extension/subagents/coordinator/tools/step.js")).default;
const authorize = (await import("../../extension/subagents/coordinator/hooks/authorize.js"))
  .default;
function context(entries: { outcome?: string; output?: unknown; turn?: string; name?: string }[]) {
  const facts: { type: string; data: unknown }[] = [{ type: "session.started", data: {} }];
  for (const [i, entry] of entries.entries()) {
    const turnId = entry.turn ?? "current";
    facts.push(
      {
        type: "turn.started",
        data: { turnId, cause: { deliveryId: `delivery-${i}` }, follows: null },
      },
      {
        type: "call.requested",
        data: {
          callId: `call-${i}`,
          owner: { turnId },
          capability: { kind: "agent", name: entry.name ?? "analyst" },
        },
      },
      { type: "call.started", data: { callId: `call-${i}` } },
    );
    if (entry.outcome)
      facts.push({
        type: "call.settled",
        data: { callId: `call-${i}`, outcome: entry.outcome, output: entry.output },
      });
  }
  const ctx = {
    view: foldEvents(
      emptySessionView(),
      facts.map((fact, line) => ({
        ...fact,
        meta: { position: { line, index: 0 }, at: "2026-11-20T00:00:00Z", endOfLine: true },
      })) as ReceivedEvent[],
    ),
    session: {
      id: "coordinator",
      turn: { id: "current" },
      auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime" } },
      parent: { sessionId: "root-fixture", rootSessionId: "root-fixture" },
    },
  };
  authorize.events!["call.settled"]!({} as never, ctx as never);
  return ctx as never;
}
function reset() {
  active = {
    lease: { owner: "owner", fence: 1, until: Date.now() + 60_000 },
    experiment: { ...experiment(), status: "review", reviewDigest: "current-review" },
  };
}
test("coordinator uses the analyst's committed result rather than a substituted decision", async () => {
  reset();
  const result = await step.execute!(
    {
      action: "review",
      result: JSON.stringify({ action: "accept", reason: "Coordinator substitution" }),
    } as never,
    context([
      {
        outcome: "completed",
        output: JSON.stringify({ action: "wait", reason: "Await human clarification" }),
      },
    ]),
  );
  assert.equal(active.experiment!.reviewedDigest, undefined);
  assert.equal(active.experiment!.reason, "Await human clarification");
  assert.equal((result as { action: string }).action, "done");
});
test("coordinator rejects missing, stale-turn, failed or unavailable analyst results", async () => {
  for (const entries of [
    [],
    [{ outcome: "completed", output: "{}", turn: "previous" }],
    [{ outcome: "failed" }],
    [{ outcome: "completed" }],
    [{ outcome: "completed", output: "x".repeat(16001) }],
    [{ outcome: "rejected" }],
    [{ outcome: "interrupted" }],
    [{ outcome: "completed", output: "{}", name: "maintainer" }],
    [{ outcome: "completed", output: "{}" }, { outcome: "failed" }],
  ]) {
    reset();
    await assert.rejects(async () => {
      await step.execute!(
        {
          action: "review",
          result: JSON.stringify({ action: "accept", reason: "No committed decision" }),
        } as never,
        context(entries),
      );
    }, /completed analyst.*result/);
    assert.equal(active.experiment!.reviewedDigest, undefined);
  }
});

test("coordinator preserves the pending stage while the analyst is still running", async () => {
  reset();
  const result = await step.execute!({ action: "review" }, context([{}]));
  assert.equal((result as { action: string }).action, "pending");
  assert.equal(active.experiment!.reviewedDigest, undefined);
});
