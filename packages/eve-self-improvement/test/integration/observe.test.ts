import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { emptySessionView, foldEvents, type ReceivedEvent } from "eve/events";
import type { SessionAuth } from "eve/context";
import { config } from "./fixtures.js";
import type { Observation } from "../../extension/lib/types.js";

const c = config();
const samples: Observation[] = [];
let storageFailure: Error | undefined;
let scope = {
  current: "turn",
  previous: null,
  currentTargets: [] as string[],
  previousTargets: [] as string[],
};
mock.module("eve/context", {
  exports: {
    defineState: () => ({
      get: () => scope,
      update: (update: (value: typeof scope) => typeof scope) => {
        scope = update(scope);
      },
    }),
  },
});
mock.module("../../extension/extension.js", { exports: { default: { config: c } } });
mock.module("../../extension/lib/store.js", {
  exports: {
    store: () => ({
      async observe(sample: Observation) {
        if (storageFailure) throw storageFailure;
        samples.push(sample);
      },
    }),
  },
});
const hook = (await import("../../extension/hooks/observe.js")).default;
const { pseudonym } = await import("../../extension/lib/observe.js");
const facts = [
  { type: "session.started", data: {} },
  {
    type: "turn.started",
    data: { turnId: "turn", cause: { deliveryId: "delivery" }, follows: null },
  },
  {
    type: "call.requested",
    data: {
      callId: "call",
      owner: { turnId: "turn" },
      capability: { kind: "tool", name: "search" },
    },
  },
  { type: "call.started", data: { callId: "call" } },
  { type: "call.settled", data: { callId: "call", outcome: "completed", output: {} } },
  { type: "turn.settled", data: { turnId: "turn", outcome: "completed" } },
];
const view = foldEvents(
  emptySessionView(),
  facts.map((fact, line) => ({
    ...fact,
    meta: { position: { line, index: 0 }, at: "2026-11-20T00:00:00Z", endOfLine: true },
  })) as ReceivedEvent[],
);
async function record(session: string, auth: SessionAuth["current"]) {
  const ctx = {
    view,
    now: new Date("2026-11-20T00:00:00Z"),
    session: { id: session, auth: { current: auth } },
    occurrence: { idempotencyKey: "tool" },
  };
  await hook.events!["call.settled"]!(
    { data: { callId: "call", outcome: "completed" } } as never,
    ctx as never,
  );
  await hook.events!["turn.settled"]!(
    { data: { turnId: "turn", outcome: "completed" } } as never,
    { ...ctx, occurrence: { idempotencyKey: "turn" } } as never,
  );
}

test("observation hooks scope anonymous identities per session and preserve authenticated identities", async () => {
  samples.length = 0;
  await record("anonymous-one", null);
  await record("anonymous-two", null);
  const owner = {
    authenticator: "basic",
    principalId: "owner",
    principalType: "user",
    attributes: {},
  };
  await record("owner-one", owner);
  await record("owner-two", owner);
  assert.equal(samples.length, 8);
  for (const kind of ["tool", "turn"] as const) {
    const [first, second, sameOwner, otherSession] = samples.filter(
      (sample) => sample.kind === kind,
    );
    assert.notEqual(first.principal, second.principal);
    assert.equal(sameOwner.principal, otherSession.principal);
    assert.equal(sameOwner.principal, pseudonym(c, "basic:owner"));
    assert.notEqual(first.principal, sameOwner.principal);
    assert.equal(first.target, kind === "tool" ? "search" : "agent");
    assert.equal(first.outcome, "completed");
    assert.ok(!JSON.stringify(samples).includes("anonymous-one"));
  }
  assert.equal(samples[0].principal, samples[1].principal);
});

test("telemetry failures warn once without exposing provider details or interrupting user turns", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  storageFailure = new Error("PRIVATE_TOKEN https://storage.example.com/private-data");
  try {
    await record("failed-one", null);
    await record("failed-two", null);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /private storage.*HMAC/);
    assert.ok(!JSON.stringify(warnings).includes("PRIVATE_TOKEN"));
    assert.ok(!JSON.stringify(warnings).includes("storage.example.com"));
  } finally {
    storageFailure = undefined;
  }
});
