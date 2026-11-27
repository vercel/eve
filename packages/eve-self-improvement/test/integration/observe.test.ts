import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { emptySessionView, foldEvents, type ReceivedEvent } from "eve/events";
import type { SessionAuth } from "eve/context";
import { config } from "./fixtures.js";
import type { Observation } from "../../extension/lib/types.js";

const c = config();
let activeConfig = c;
const samples: Observation[] = [];
let observeAttempts = 0;
let storageFailure: Error | undefined;
let observeGate: Promise<void> | undefined;
const failIds = new Set<string>();
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
mock.module("../../extension/extension.js", {
  exports: {
    default: {
      get config() {
        return activeConfig;
      },
    },
  },
});
mock.module("../../extension/lib/store.js", {
  exports: {
    store: () => ({
      async observe(sample: Observation) {
        observeAttempts++;
        if (observeGate) await observeGate;
        if (storageFailure) throw storageFailure;
        if (failIds.has(sample.id)) throw new Error(`transient failure for ${sample.id}`);
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

test("call.settled buffers tool observations and flushes them on turn.paused and turn.settled", async () => {
  samples.length = 0;
  const ctx = {
    view,
    now: new Date("2026-11-20T00:00:00Z"),
    session: { id: "buffered-session", auth: { current: null } },
    occurrence: { idempotencyKey: "tool-1" },
  };
  await hook.events!["call.settled"]!(
    { data: { callId: "call", outcome: "completed" } } as never,
    ctx as never,
  );
  await hook.events!["call.settled"]!(
    { data: { callId: "call", outcome: "completed" } } as never,
    { ...ctx, occurrence: { idempotencyKey: "tool-2" } } as never,
  );
  assert.equal(samples.length, 0);

  await hook.events!["turn.paused"]!(
    { data: { turnId: "turn" } } as never,
    { ...ctx, occurrence: { idempotencyKey: "pause" } } as never,
  );
  assert.equal(samples.length, 2);
  assert.deepEqual(
    samples.map((sample) => sample.kind),
    ["tool", "tool"],
  );

  await hook.events!["call.settled"]!(
    { data: { callId: "call", outcome: "completed" } } as never,
    { ...ctx, occurrence: { idempotencyKey: "tool-3" } } as never,
  );
  assert.equal(samples.length, 2);

  await hook.events!["turn.settled"]!(
    { data: { turnId: "turn", outcome: "completed" } } as never,
    { ...ctx, occurrence: { idempotencyKey: "turn-end" } } as never,
  );
  assert.equal(samples.length, 4);
  assert.deepEqual(
    samples.slice(2).map((sample) => sample.kind),
    ["tool", "turn"],
  );
});

test("non-completed tool outcomes flush immediately instead of buffering", async () => {
  samples.length = 0;
  const ctx = {
    view,
    now: new Date("2026-11-20T00:00:00Z"),
    session: { id: "failed-tool-session", auth: { current: null } },
    occurrence: { idempotencyKey: "tool-fail" },
  };
  await hook.events!["call.settled"]!(
    { data: { callId: "call", outcome: "failed" } } as never,
    ctx as never,
  );
  assert.equal(samples.length, 1);
  assert.equal(samples[0].outcome, "failed");
});

test("turn.started preserves buffered observations, >8 observations span batches, and 200 auto-flushes", async () => {
  samples.length = 0;
  scope = {
    current: "turn",
    previous: null,
    currentTargets: [],
    previousTargets: [],
    pendingObservations: [],
  } as typeof scope;
  const baseCtx = {
    view,
    now: new Date("2026-11-20T00:00:00Z"),
    session: { id: "batch-session", auth: { current: null } },
  };
  for (let i = 0; i < 10; i++) {
    await hook.events!["call.settled"]!(
      { data: { callId: "call", outcome: "completed" } } as never,
      { ...baseCtx, occurrence: { idempotencyKey: `k-${i}` } } as never,
    );
  }
  await hook.events!["turn.started"]!({ data: { turnId: "turn-2" } } as never, baseCtx as never);
  assert.equal(samples.length, 0);

  await hook.events!["turn.paused"]!(
    { data: { turnId: "turn-2" } } as never,
    { ...baseCtx, occurrence: { idempotencyKey: "pause-2" } } as never,
  );
  assert.equal(samples.length, 10);

  samples.length = 0;
  for (let i = 0; i < 200; i++) {
    await hook.events!["call.settled"]!(
      { data: { callId: "call", outcome: "completed" } } as never,
      { ...baseCtx, occurrence: { idempotencyKey: `cap-${i}` } } as never,
    );
  }
  assert.equal(samples.length, 200);
});

test("observeBatch stops early on full-batch outage, keeps writing on partial failure, and respects AbortSignal", async () => {
  const { observeBatch } = await import("../../extension/lib/observe.js");
  const batch: Observation[] = Array.from({ length: 16 }, (_, i) => ({
    at: 1000 + i,
    id: `obs-${i}`,
    kind: "tool",
    outcome: "completed",
    principal: "p",
    session: "s",
    target: "search",
    turn: "t",
  }));

  samples.length = 0;
  observeAttempts = 0;
  storageFailure = new Error("outage");
  try {
    const outcome = await observeBatch(c, batch);
    assert.equal(outcome, "failed");
    assert.equal(observeAttempts, 8);
  } finally {
    storageFailure = undefined;
  }

  samples.length = 0;
  observeAttempts = 0;
  failIds.clear();
  failIds.add("obs-1");
  failIds.add("obs-10");
  try {
    const outcome = await observeBatch(c, batch);
    assert.equal(outcome, "failed");
    assert.equal(observeAttempts, 16);
    assert.equal(samples.length, 14);
    assert.ok(!samples.some((sample) => sample.id === "obs-1" || sample.id === "obs-10"));
  } finally {
    failIds.clear();
  }

  samples.length = 0;
  observeAttempts = 0;
  const abort = new AbortController();
  abort.abort();
  assert.equal(await observeBatch(c, batch, { signal: abort.signal }), "aborted");
  assert.equal(observeAttempts, 0);
  assert.equal(samples.length, 0);

  samples.length = 0;
  observeAttempts = 0;
  const inFlightAbort = new AbortController();
  let releaseHung!: () => void;
  observeGate = new Promise<void>((resolve) => {
    releaseHung = resolve;
  });
  try {
    const flushing = observeBatch(c, batch.slice(0, 2), { signal: inFlightAbort.signal });
    await Promise.resolve();
    inFlightAbort.abort();
    assert.equal(await flushing, "aborted");
    assert.equal(observeAttempts, 2);
  } finally {
    observeGate = undefined;
    releaseHung();
  }
});

test("interrupted call.settled writes immediately even when occurrence.abortSignal is already aborted without warning", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  samples.length = 0;
  const abort = new AbortController();
  abort.abort();
  const ctx = {
    view,
    now: new Date("2026-11-20T00:00:00Z"),
    session: { id: "interrupted-session", auth: { current: null } },
    occurrence: { abortSignal: abort.signal, idempotencyKey: "interrupted-tool" },
  };
  await hook.events!["call.settled"]!(
    { data: { callId: "call", outcome: "interrupted" } } as never,
    ctx as never,
  );
  assert.equal(samples.length, 1);
  assert.equal(samples[0].outcome, "interrupted");
  assert.equal(warnings.length, 0);
});

test("call.settled still updates currentTargets when pseudonymization fails", async () => {
  samples.length = 0;
  scope = {
    current: "turn",
    previous: null,
    currentTargets: [],
    previousTargets: [],
    pendingObservations: [],
  } as typeof scope;
  activeConfig = config({ hmacSecret: () => "" });
  try {
    const ctx = {
      view,
      now: new Date("2026-11-20T00:00:00Z"),
      session: { id: "missing-hmac", auth: { current: null } },
      occurrence: { idempotencyKey: "tool-no-hmac" },
    };
    await hook.events!["call.settled"]!(
      { data: { callId: "call", outcome: "completed" } } as never,
      ctx as never,
    );
    assert.deepEqual(scope.currentTargets, ["search"]);
    assert.equal(samples.length, 0);
  } finally {
    activeConfig = c;
  }
});
