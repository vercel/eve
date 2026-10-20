import { describe, expect, it } from "vitest";

import { createStreamChecker, type ViolationRule } from "#protocol/session-events/checker.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";

const at = "2026-10-09T00:00:00.000Z";
const turn = { turnId: "turn_0" };
const run = { runId: "run_0", turnId: "turn_0" };

/** One line per argument: a commit of its facts. */
function commits(...lines: readonly unknown[][]): StoredLine[] {
  return lines.map((facts) => ({ at, facts }));
}

/** A turn that answers a message with one reply part. */
function repliedTurn(): StoredLine[] {
  return commits(
    [
      { data: {}, type: "session.started" },
      { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
    ],
    [
      {
        data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
        scope: turn,
        type: "turn.started",
      },
      {
        data: { deliveryId: "d_0", parts: [], turnId: "turn_0" },
        scope: turn,
        type: "delivery.consumed",
      },
    ],
    [{ data: { owner: turn, runId: "run_0" }, scope: run, type: "model.requested" }],
    [{ data: { attempt: 0, modelId: "m", runId: "run_0" }, scope: run, type: "model.started" }],
    [
      {
        data: { kind: "text", partId: "p_0", phase: "reply", runId: "run_0", value: "Hi." },
        scope: run,
        type: "content.completed",
      },
      { data: { outcome: "completed", runId: "run_0" }, scope: run, type: "model.settled" },
    ],
    [
      {
        data: { outcome: "completed", reply: ["p_0"], turnId: "turn_0" },
        scope: turn,
        type: "turn.settled",
      },
      {
        data: { deliveryId: "d_0", outcome: "handled", turnId: "turn_0" },
        type: "delivery.settled",
      },
    ],
  );
}

function rulesOf(lines: readonly StoredLine[], seedFrom?: readonly StoredLine[]): ViolationRule[] {
  let seed: ReturnType<typeof emptySessionView> | undefined;
  if (seedFrom !== undefined) {
    seed = emptySessionView();
    foldLines(seed, seedFrom, 0, { retention: "operational" });
  }
  const checker = createStreamChecker({ seed });
  const offset = seedFrom?.length ?? 0;
  return lines.flatMap((line, index) => checker.check(line, offset + index).map((v) => v.rule));
}

describe("createStreamChecker", () => {
  it("accepts a turn that introduces and settles everything it names", () => {
    expect(rulesOf(repliedTurn())).toEqual([]);
  });

  it("refuses a fact that names what was never introduced", () => {
    const lines = repliedTurn();
    lines.splice(2, 1);
    expect(rulesOf(lines)).toContain("introduce-before-reference");
  });

  it("refuses an entity introduced twice", () => {
    const lines = [
      ...repliedTurn().slice(0, 3),
      ...commits([{ data: { owner: turn, runId: "run_0" }, scope: run, type: "model.requested" }]),
    ];
    expect(rulesOf(lines)).toEqual(["introduced-twice"]);
  });

  it("refuses a second terminal", () => {
    const lines = [
      ...repliedTurn().slice(0, 5),
      ...commits([
        { data: { outcome: "failed", runId: "run_0" }, scope: run, type: "model.settled" },
      ]),
    ];
    expect(rulesOf(lines)).toEqual(["one-terminal"]);
  });

  it("refuses an outcome outside the terminal's closed set", () => {
    const lines = repliedTurn();
    lines[5] = {
      at,
      facts: [
        {
          data: { outcome: "done", reply: ["p_0"], turnId: "turn_0" },
          scope: turn,
          type: "turn.settled",
        },
        {
          data: { deliveryId: "d_0", outcome: "handled", turnId: "turn_0" },
          type: "delivery.settled",
        },
      ],
    };
    expect(rulesOf(lines)).toEqual(["closed-outcome"]);
  });

  it("refuses a turn that ends while its run is still open", () => {
    const lines = [
      ...repliedTurn().slice(0, 4),
      ...commits([
        { data: { outcome: "completed", turnId: "turn_0" }, scope: turn, type: "turn.settled" },
        {
          data: { deliveryId: "d_0", outcome: "handled", turnId: "turn_0" },
          type: "delivery.settled",
        },
      ]),
    ];
    expect(rulesOf(lines)).toEqual(["closure"]);
  });

  it("accepts a run's attempts in order, and refuses one out of order or after it settled", () => {
    const started = (attempt: number) => ({
      data: { attempt, modelId: "m", runId: "run_0" },
      scope: run,
      type: "model.started",
    });
    const retried = (attempt: number) => ({
      data: { attempt, error: { code: "MODEL_CALL_FAILED", message: "429" }, runId: "run_0" },
      scope: run,
      type: "model.retried",
    });
    const lines = repliedTurn();
    const retriedTurn = [
      ...lines.slice(0, 4),
      ...commits([retried(0)], [started(1)], [retried(1)], [started(2)]),
      ...lines.slice(4),
    ];
    expect(rulesOf(retriedTurn)).toEqual([]);
    expect(rulesOf([...lines.slice(0, 4), ...commits([retried(1)])])).toEqual(["attempts"]);
    expect(rulesOf([...lines.slice(0, 4), ...commits([started(0)])])).toEqual(["attempts"]);
    expect(rulesOf([...lines.slice(0, 5), ...commits([retried(0)])])).toEqual(["one-terminal"]);
  });

  it("refuses a second open turn and facts after the session ended", () => {
    const second = commits([
      {
        data: { cause: { hook: "h" }, follows: null, turnId: "turn_1" },
        scope: { turnId: "turn_1" },
        type: "turn.started",
      },
    ]);
    expect(rulesOf([...repliedTurn().slice(0, 2), ...second])).toContain("one-open-turn");

    const ended = commits(
      [{ data: { outcome: "completed" }, type: "session.ended" }],
      [{ data: { deliveryId: "d_9" }, type: "delivery.admitted" }],
    );
    expect(rulesOf([...repliedTurn(), ...ended])).toEqual(["after-session-end"]);
  });

  it("refuses an empty commit and passes facts it doesn't know", () => {
    expect(rulesOf([...repliedTurn(), { at, facts: [] }])).toEqual(["envelope"]);
    expect(rulesOf([...repliedTurn(), ...commits([{ data: {}, type: "future.thing" }])])).toEqual(
      [],
    );
  });

  it("refuses a delta for a part that already completed, or one announced outside a run", () => {
    const late: StoredLine = {
      progress: { data: { delta: "x", partId: "p_0" }, scope: run, type: "content.delta" },
    };
    expect(rulesOf([...repliedTurn(), late])).toEqual(["progress"]);

    const stray: StoredLine = {
      progress: {
        data: { delta: "x", kind: "text", partId: "p_9" },
        scope: run,
        type: "content.delta",
      },
    };
    expect(rulesOf([...repliedTurn(), stray])).toEqual(["progress"]);
  });

  it("refuses a pause on someone the turn doesn't wait on", () => {
    const lines = repliedTurn().slice(0, 4);
    lines.push(
      ...commits([
        {
          data: { awaiting: [{ interactionId: "i_0" }], turnId: "turn_0" },
          scope: turn,
          type: "turn.paused",
        },
      ]),
    );
    expect(rulesOf(lines)).toEqual(["paused-on-person", "paused-on-person"]);
  });

  it("refuses a call served by a task that ended", () => {
    const lines = repliedTurn().slice(0, 4);
    lines.push(
      ...commits(
        [
          {
            data: {
              callId: "c_0",
              capability: { kind: "agent", name: "a" },
              owner: { runId: "run_0" },
            },
            scope: run,
            type: "call.requested",
          },
          {
            data: { kind: "agent", name: "a", startedBy: { callId: "c_0" }, taskId: "t_0" },
            type: "task.started",
          },
          { data: { outcome: "completed", taskId: "t_0" }, type: "task.ended" },
        ],
        [{ data: { callId: "c_0", taskId: "t_0" }, type: "call.started" }],
      ),
    );
    expect(rulesOf(lines)).toEqual(["serves-running-task"]);
  });

  it("refuses an approval decided apart from the rest of its batch", () => {
    const approval = (callId: string, interactionId: string) => [
      {
        data: { callId, capability: { kind: "tool", name: "deploy" }, owner: { runId: "run_0" } },
        scope: run,
        type: "call.requested",
      },
      {
        data: {
          interactionId,
          request: { kind: "approval", prompt: "Deploy?" },
          subject: { callId },
        },
        type: "interaction.opened",
      },
    ];
    const lines = repliedTurn().slice(0, 4);
    lines.push(
      ...commits(
        [...approval("c_0", "i_0"), ...approval("c_1", "i_1")],
        [{ data: { interactionId: "i_0", outcome: "accepted" }, type: "interaction.settled" }],
      ),
    );
    expect(rulesOf(lines)).toEqual(["batch-settles-together"]);
  });

  it("skips a line at a position it already checked", () => {
    const checker = createStreamChecker();
    const lines = repliedTurn();
    for (const [index, line] of lines.entries()) checker.check(line, index);
    expect(checker.check(lines[0]!, 0)).toEqual([]);
  });

  it("checks on from a checkpoint's view, knowing what it holds open", () => {
    const lines = repliedTurn();
    expect(rulesOf(lines.slice(3), lines.slice(0, 3))).toEqual([]);
    // The checkpoint knows the run, so introducing it again is refused.
    const again = commits([
      { data: { owner: turn, runId: "run_0" }, scope: run, type: "model.requested" },
    ]);
    expect(rulesOf(again, lines.slice(0, 3))).toEqual(["introduced-twice"]);
  });
});
