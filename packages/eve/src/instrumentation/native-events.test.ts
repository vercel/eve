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

    expect(heard.filter((event) => event.type.startsWith("step.attempt."))).toMatchObject([
      {
        error: new Error("Overloaded"),
        idempotencyKey: "step:s:turn_0:0:0",
        scope: {
          attemptId: "s:turn_0:0:0",
          attemptIndex: 0,
          functionId: "assistant",
          stepIndex: 0,
        },
        type: "step.attempt.failed",
      },
      {
        idempotencyKey: "step:s:turn_0:0:1",
        scope: { attemptId: "s:turn_0:0:1", attemptIndex: 1, stepIndex: 0 },
        type: "step.attempt.completed",
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
        .filter((event) => event.type.startsWith("step.attempt."))
        .map((event) => ("scope" in event ? [event.type, event.scope.attemptId] : [])),
    ).toEqual([
      ["step.attempt.failed", "s:turn_0:0:0"],
      ["step.attempt.completed", "s:turn_0:1:1"],
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
        .filter((event) => event.type.startsWith("step.attempt.") || event.type.startsWith("tool."))
        .map((event) => event.type),
    ).toEqual(["tool.call.started", "tool.call.failed", "step.attempt.completed"]);
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
      heard.filter((event) => event.type.startsWith("step.attempt.")).map((event) => event.type),
    ).toEqual(["step.attempt.failed"]);
  });
});
