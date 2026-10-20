import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import {
  currentView,
  enterSessionProjectionAt,
  nextLinePosition,
  recordPublishedLine,
} from "#harness/session-machine/current.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import { createInstrumentationHandleEvent } from "#instrumentation/native-events.js";
import type { SessionEvent } from "#protocol/session-event.js";

const at = "2026-10-09T00:00:00.000Z";
const turn = { turnId: "turn_0" };
const scope = (runId: string) => ({ runId, turnId: "turn_0" });
const overloaded = { code: "MODEL_CALL_FAILED", message: "Overloaded" };

/**
 * Publishes each commit as the writer does, closing what its owners' ends hold, and collects what
 * instrumentation hears.
 */
function session() {
  const ctx = new ContextContainer();
  enterSessionProjectionAt(ctx, undefined);
  const heard: InstrumentationEvent[] = [];
  const handle = createInstrumentationHandleEvent({
    functionId: "assistant",
    handleEvent: async (publication) => {
      const facts = cascade(currentView(ctx), eventsOf(publication));
      recordPublishedLine(ctx, { at, facts }, nextLinePosition(ctx), facts);
    },
    hooks: { capturesContent: false, publish: async (event) => void heard.push(event) },
    sessionId: "s",
  })!;
  return {
    ctx,
    heard,
    commit: (...facts: SessionEvent[]) => contextStorage.run(ctx, () => handle(facts)),
  };
}

const opening: SessionEvent[] = [
  { data: {}, type: "session.started" },
  {
    data: { cause: { hook: "h" }, follows: null, turnId: "turn_0" },
    scope: turn,
    type: "turn.started",
  },
  { data: { owner: turn, runId: "run_0" }, scope: scope("run_0"), type: "model.requested" },
] as SessionEvent[];

function started(runId: string, attempt: number): SessionEvent {
  return { data: { attempt, modelId: "m", runId }, scope: scope(runId), type: "model.started" };
}

describe("step attempts from the stream", () => {
  it("ends each attempt of a run as its facts do, scoped from the run's row", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: { attempt: 0, error: overloaded, runId: "run_0" },
      scope: scope("run_0"),
      type: "model.retried",
    });
    await commit(started("run_0", 1));
    await commit({
      data: { outcome: "completed", runId: "run_0" },
      scope: scope("run_0"),
      type: "model.settled",
    });

    expect(heard.filter((event) => event.type.startsWith("model."))).toMatchObject([
      {
        error: new Error("Overloaded"),
        idempotencyKey: "model-run:s:run_0:0",
        scope: {
          runId: "run_0",
          attempt: 0,
          functionId: "assistant",
        },
        type: "model.retried",
      },
      {
        outcome: "completed",
        idempotencyKey: "model-run:s:run_0:1",
        scope: { runId: "run_0", attempt: 1 },
        type: "model.settled",
      },
    ]);
  });

  it("counts a replacement run's attempts on from the run a retry gave up", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: { outcome: "abandoned", runId: "run_0" },
      scope: scope("run_0"),
      type: "model.settled",
    });
    await commit({
      data: { owner: turn, runId: "run_1" },
      scope: scope("run_1"),
      type: "model.requested",
    });
    await commit(started("run_1", 1));
    await commit({
      data: { outcome: "completed", runId: "run_1" },
      scope: scope("run_1"),
      type: "model.settled",
    });

    expect(
      heard
        .filter((event) => event.type.startsWith("model."))
        .map((event) => ("scope" in event ? [event.type, attemptIdempotencyKey(event.scope)] : [])),
    ).toEqual([
      ["model.settled", "model-run:s:run_0:0"],
      ["model.settled", "model-run:s:run_1:1"],
    ]);
  });

  // A cancel stops the model call on purpose, so its attempt ends without failing (#5025).
  it("hears what a turn's end closes with it, as the writer commits it", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: {
        callId: "call_0",
        capability: { kind: "tool", name: "wait" },
        input: {},
        owner: { runId: "run_0" },
      },
      scope: scope("run_0"),
      type: "call.requested",
    } as SessionEvent);
    await commit({
      data: { outcome: "cancelled", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);

    expect(
      heard
        .filter((event) => event.type.startsWith("model.") || event.type.startsWith("call."))
        .map((event) => [event.type, "outcome" in event ? event.outcome : undefined]),
    ).toEqual([
      ["call.requested", undefined],
      ["call.settled", "interrupted"],
      ["model.settled", "completed"],
    ]);
  });

  it("fails the attempt a failed turn's end closes", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: { error: overloaded, outcome: "failed", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);

    expect(
      heard.flatMap((event) => (event.type === "model.settled" ? [event.outcome] : [])),
    ).toEqual(["interrupted"]);
  });
});

describe("calls and deliveries from the stream", () => {
  function agentCall(callId: string, remote?: true): SessionEvent {
    return {
      data: {
        callId,
        capability: { kind: "agent", name: "research", ...(remote && { remote }) },
        input: { message: "Find the 2025 report." },
        owner: { runId: "run_0" },
      },
      scope: scope("run_0"),
      type: "call.requested",
    } as SessionEvent;
  }

  it("reports a remote agent's call as one, and a subagent's as a subagent call", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit(agentCall("call_remote", true), agentCall("call_local"));

    expect(
      heard.flatMap((event) =>
        event.type === "call.requested" ? [[event.callId, event.capability]] : [],
      ),
    ).toEqual([
      ["call_remote", { kind: "agent", name: "research", remote: true }],
      ["call_local", { kind: "agent", name: "research" }],
    ]);
  });

  it("publishes delivery settlement in committed fact order without synthesizing a terminal", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(
      { type: "delivery.admitted", data: { deliveryId: "d_0" } },
      { type: "delivery.consumed", data: { deliveryId: "d_0", turnId: "turn_0", parts: [] } },
    );
    await commit({
      data: { outcome: "completed", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);

    expect(
      heard
        .filter(
          (event) =>
            (event.type === "delivery.settled" && event.outcome === "handled") ||
            event.type === "turn.settled",
        )
        .map((event) => [event.type, "turnId" in event ? event.turnId : undefined]),
    ).toEqual([
      ["turn.settled", "turn_0"],
      ["delivery.settled", "turn_0"],
    ]);
  });
});
