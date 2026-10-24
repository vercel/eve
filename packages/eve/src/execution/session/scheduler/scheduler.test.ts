import { describe, expect, it } from "vitest";

import { on, type SchedulerEvent } from "#execution/session/scheduler/events.js";
import { next, type Next, type SessionReading } from "#execution/session/scheduler/next.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import { initialScheduler, type Scheduler } from "#execution/session/scheduler/state.js";
import { takeNext } from "#execution/session/scheduler/held.js";
import type { DeliverHookPayload } from "#channel/types.js";

describe("a session between turns", () => {
  it("stops working tasks for a cancel, and settles that cancel as applied once they stop", () => {
    const parked = settle(initialScheduler({ kind: "parked" }), reading());

    const asked = performAll(
      on(parked.state, {
        arrivals: [{ kind: "cancel", origin: { deliveryId: "cancel-tasks" } }],
        kind: "arrived",
      }),
      reading({ workingTasks: true }),
    );

    expect(asked).toEqual([
      { kind: "cancel-tasks", reason: "turn-cancelled" },
      {
        kind: "settle-control",
        settlement: {
          control: { deliveryId: "cancel-tasks" },
          outcome: "applied",
          source: "cancel",
        },
      },
      { kind: "wait" },
    ]);
  });

  it("hands off a lone message that arrived while nothing waited, but not one of a burst", () => {
    const parked = settle(initialScheduler({ kind: "parked" }), reading());
    const message: SchedulerEvent = {
      arrivals: [
        { delivery: { kind: "deliver", payloads: [{ message: "next turn" }] }, kind: "delivery" },
      ],
      kind: "arrived",
    };
    const taken = (session: SessionReading) => {
      const routing = next(on(parked.state, message), session);
      expect(routing.asks.kind).toBe("route");
      const routed = on(routing.state, {
        kind: "routed",
        routed: {
          delivery: { kind: "deliver", payloads: [{ message: "next turn" }] },
          kind: "remainder",
        },
      });
      return next(routed, session).asks;
    };

    expect(taken(reading())).toMatchObject({
      kind: "take-turn",
      selection: { handoffEligible: true },
    });
    expect(taken(reading({ inboxPending: true }))).toMatchObject({
      kind: "take-turn",
      selection: { handoffEligible: false },
    });
  });

  it("expires once the inbox closes", () => {
    const parked = settle(initialScheduler({ kind: "parked" }), reading());

    expect(next(on(parked.state, { kind: "closed" }), reading()).asks).toEqual({
      end: { kind: "expired" },
      kind: "end",
    });
  });
});

describe("delivery idempotency", () => {
  const delivery = (idempotencyKey?: string): DeliverHookPayload => ({
    kind: "deliver",
    idempotencyKey,
    payloads: [{ message: "Alice asks for a report." }],
  });
  const receive = (state: Scheduler, value: DeliverHookPayload) =>
    on(state, {
      kind: "arrived",
      arrivals: [{ kind: "delivery", delivery: value }],
    });

  it("remembers consumed keys and keys restored from a predecessor", () => {
    const message = delivery("provider-1");
    const first = receive(initialScheduler({ kind: "parked" }), message);
    const consumed = { ...first, held: takeNext(first.held).held };
    for (const session of [
      consumed,
      initialScheduler({ kind: "parked" }, undefined, ["provider-1"]),
    ]) {
      expect(next(receive(session, message), reading()).asks).toEqual({
        kind: "settle-duplicate",
        delivery: message,
      });
    }
  });

  it("retains the most recent 1024 distinct keys without refreshing duplicates", () => {
    let session = initialScheduler({ kind: "parked" });
    for (let index = 0; index < 1024; index++) session = receive(session, delivery(String(index)));
    session = receive(session, delivery("0"));
    session = receive(session, delivery("1024"));
    expect(session.admittedDeliveryKeys).toHaveLength(1024);
    expect(session.admittedDeliveryKeys).not.toContain("0");
    const repeats = receive(session, delivery("1"));
    expect(repeats.held.entries).toHaveLength(session.held.entries.length);
    expect(receive(repeats, delivery("0")).held.entries).toHaveLength(
      session.held.entries.length + 1,
    );
  });

  it("keeps unkeyed input independent and scopes keys to each session", () => {
    const fresh = () => initialScheduler({ kind: "parked" });
    expect(receive(receive(fresh(), delivery()), delivery()).held.entries).toHaveLength(2);
    expect(receive(fresh(), delivery("shared")).held.entries).toHaveLength(1);
    expect(receive(fresh(), delivery("shared")).held.entries).toHaveLength(1);
  });
});

it("takes another person's answer with channel state without queueing a second delivery", () => {
  const alice = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "alice",
    principalType: "user" as const,
  };
  const session = reading();
  const started = next(
    initialScheduler({
      kind: "turn",
      input: { kind: "deliver", auth: alice, payloads: [{ message: "Alice asks to deploy." }] },
    }),
    session,
  );
  const step = next(started.state, session);
  const answer: DeliverHookPayload = {
    kind: "deliver",
    auth: { ...alice, principalId: "bob" },
    payloads: [
      {
        answers: [{ interactionId: "approval", optionId: "approve" }],
        state: { callback: "approve" },
      },
    ],
  };
  const paused = on(step.state, {
    kind: "stepped",
    result: { action: "paused", on: "interaction", attemptIds: [], requestIds: ["approval"] },
    arrivals: [{ kind: "delivery", delivery: answer }],
  });
  const routed = next(paused, session);
  expect(routed.asks.kind).toBe("route");
  const taken = next(
    on(routed.state, { kind: "routed", routed: { kind: "remainder", delivery: answer } }),
    session,
  );
  expect(taken.asks).toEqual({ kind: "step", input: { delivery: answer } });
  expect(taken.state.held.entries).toEqual([]);
});

describe("task-wait deadlines", () => {
  it("keeps each call's absolute deadline and waits on the earliest unresolved one", () => {
    const session = { ...reading({ workingTasks: true }), now: 2000 };
    const started = next(initialScheduler({ kind: "turn", input: undefined }), session);
    const step = next(started.state, session);
    expect(step.asks.kind).toBe("step");
    let state = on(step.state, {
      arrivals: [],
      kind: "stepped",
      result: {
        action: "paused",
        callIds: ["later", "first", "forever", "poll"],
        dispatch: false,
        on: "calls",
        taskToolCalls: [
          { callId: "later", kind: "eve__task_wait", timeoutMs: 3000 },
          { callId: "first", kind: "eve__task_wait", timeoutMs: 1000 },
          { callId: "forever", kind: "eve__task_wait" },
          { callId: "poll", kind: "eve__task_wait", timeoutMs: 0 },
        ],
      },
    });
    const calls = next(state, session);
    expect(calls.asks.kind).toBe("start-task-calls");
    state = on(calls.state, { answers: [], kind: "task-calls-started", startedAtMs: 2000 });

    const first = next(state, session);
    expect(first.asks).toEqual({
      kind: "wait",
      timeout: { callId: "first", deadlineMs: 3000 },
    });
    const unrelated = on(first.state, { arrivals: [{ kind: "ignored" }], kind: "arrived" });
    expect(next(unrelated, { ...session, now: 2800 }).asks).toEqual(first.asks);
    // Even past the deadline, the host orders timeout delivery against inbox arrivals.
    expect(next(unrelated, { ...session, now: 4000 }).asks).toEqual(first.asks);

    const second = next(on(unrelated, { callId: "first", kind: "timed-out" }), {
      ...session,
      now: 3000,
    });
    expect(second.asks).toEqual({
      kind: "wait",
      timeout: { callId: "later", deadlineMs: 5000 },
    });
    const last = next(on(second.state, { callId: "later", kind: "timed-out" }), {
      ...session,
      now: 5000,
    });
    expect(last.asks).toEqual({ kind: "wait" });
    const resumed = next(last.state, { ...session, tasks: { settled: [], working: [] } });
    expect(resumed.asks).toMatchObject({
      kind: "step",
      input: {
        runtimeResults: {
          results: [
            { callId: "later", output: expect.stringContaining("Stopped waiting after 3s") },
            { callId: "first", output: expect.stringContaining("Stopped waiting after 1s") },
            { callId: "forever", output: "No tasks are working." },
            { callId: "poll", output: expect.stringContaining("Stopped waiting after 0ms") },
          ],
        },
      },
    });
  });
});

/** What the session reads of a started session with nothing open, unless `changes` says otherwise. */
function reading(
  changes: Partial<Record<"inboxPending" | "workingTasks", boolean>> = {},
): SessionReading {
  const view = emptySessionView();
  return {
    canAskPeople: true,
    inboxPending: changes.inboxPending === true,
    now: 0,
    principal: "anonymous",
    recordedRuns: new Map(),
    tasks: { settled: [], working: changes.workingTasks === true ? ["task_1"] : [] },
    turnId: "turn_1",
    view: { ...view, session: { ...view.session, status: "open" } },
  };
}

/** Runs the scheduler until it waits on the inbox. */
function settle(
  state: Scheduler,
  session: SessionReading,
): { readonly state: Scheduler; readonly asked: Next[] } {
  const asked: Next[] = [];
  let current = state;
  for (;;) {
    const decision = next(current, session);
    asked.push(decision.asks);
    current = decision.state;
    if (decision.asks.kind === "wait") return { asked, state: current };
  }
}

function performAll(state: Scheduler, session: SessionReading): Next[] {
  return settle(state, session).asked;
}
