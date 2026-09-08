import { type EveEvalContext, type EveEvalTurn, type InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";

const FANOUT_SIZE = 100;
const COMPLETED_NOTIFICATION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

export default (["burst", "staggered"] as const).map((schedule) =>
  defineTaskEval({
    description: `Measure completion-driven parent model steps for 100 children (${schedule}).`,
    timeoutMs: 600_000,
    transition: {
      primary: "task.parent.wake.emitted-ready",
      setup: [
        "task.dispatch.start.accepted-acknowledged",
        "task.input.require.accepted-valid-batch",
        "task.input.answer.accepted-complete",
        "task.lifecycle.complete.accepted-nonterminal",
      ],
      dimensions: { transport: "local", parentPhase: "parked" },
    },
    async test(t) {
      const started = await t.send("TASK-BATCHING-BENCHMARK");
      started.expectOk();
      started.calledSubagent("fanout-worker", { count: FANOUT_SIZE });
      const taskIds = started.events.flatMap((event) =>
        event.type === "subagent.completed" && event.data.backgroundTask !== undefined
          ? [event.data.backgroundTask.taskId]
          : [],
      );
      await t.require(
        taskIds,
        satisfies(
          (ids: readonly string[]) =>
            ids.length === FANOUT_SIZE && new Set(ids).size === FANOUT_SIZE,
          "100 distinct background task receipts",
        ),
      );

      let session: TaskEvalSessionDriver = t;
      const requests = new Map<string, InputRequest>();
      collectRequests(started, requests);
      for (let attempt = 0; requests.size < FANOUT_SIZE && attempt < FANOUT_SIZE; attempt += 1) {
        const next = await nextTurn(t, session);
        session = next.session;
        collectRequests(next.turn, requests);
      }
      if (requests.size !== FANOUT_SIZE) {
        throw new Error(`Expected 100 release requests; received ${requests.size}.`);
      }

      // All setup/input-required wakes have finished before measurement starts.
      const completionTurns: EveEvalTurn[] = [];
      const notifications: string[] = [];
      const observe = (turn: EveEvalTurn) => {
        turn.expectOk();
        const ids = completedTaskIds(turn);
        notifications.push(...ids);
        if (ids.length > 0) completionTurns.push(turn);
      };
      const waitForCompletions = async (count: number) => {
        for (let attempt = 0; notifications.length < count && attempt < FANOUT_SIZE; attempt += 1) {
          const next = await nextTurn(t, session);
          session = next.session;
          observe(next.turn);
        }
        if (notifications.length !== count) {
          throw new Error(
            `Expected ${count} completed deliveries; received ${notifications.length}.`,
          );
        }
      };
      const release = async (batch: readonly InputRequest[]) => {
        observe(
          await session.respond(
            batch.map((request) => ({
              optionId: "approve",
              requestId: request.requestId,
            })),
          ),
        );
      };

      const releases = [...requests.values()];
      const last = releases.pop();
      if (last === undefined) throw new Error("No final release request.");
      if (schedule === "burst") {
        await release(releases);
        await waitForCompletions(FANOUT_SIZE - 1);
      } else {
        for (const [index, request] of releases.entries()) {
          await release([request]);
          // The next child cannot complete until this parent's response has finished.
          await waitForCompletions(index + 1);
        }
      }

      const intermediate = metrics(completionTurns);
      t.check(
        intermediate.visibleMessages,
        satisfies((count) => count === 0, "all intermediate completion responses are silent"),
      );

      // A real user turn must still produce an answer with one sibling blocked.
      const question = await session.send("TASK-BATCHING-QUESTION");
      question.expectOk();
      t.check(
        question.message,
        satisfies(
          (message) => message === "56",
          "user question receives exactly 56 while the final child is blocked",
        ),
      );
      question.usedNoTools();
      observe(question);

      await release([last]);
      await waitForCompletions(FANOUT_SIZE);
      t.check(
        notifications,
        satisfies(
          (ids: readonly string[]) =>
            JSON.stringify([...ids].sort()) === JSON.stringify([...taskIds].sort()),
          "every child result is delivered exactly once, with no unknown task ids",
        ),
      );
      const expected = Array.from(
        { length: FANOUT_SIZE },
        (_, index) => `FANOUT-COMPLETE:FANOUT-WORKER-${index + 1}`,
      ).sort();
      const final = completionTurns.at(-1);
      if (final === undefined) throw new Error("No final completion turn.");
      t.check(
        final.message,
        satisfies(
          (message) =>
            message === JSON.stringify({ report: "TASK-BATCHING-REPORT", results: expected }),
          "final report contains every distinct child result exactly once",
        ),
      );
      const total = metrics(completionTurns);
      t.check(
        total.visibleMessages,
        satisfies((count) => count === 1, "one visible final report across all completion turns"),
      );
      t.log(
        `task-batching ${JSON.stringify({ schedule, children: FANOUT_SIZE, intermediate, total })}`,
      );
      t.notEvent("compaction.requested");
      t.noFailedActions();
    },
  }),
);

function metrics(turns: readonly EveEvalTurn[]) {
  const events = turns.flatMap((turn) => turn.events);
  return {
    parentTurns: turns.length,
    modelSteps: events.filter((event) => event.type === "step.started").length,
    silentMessages: events.filter(
      (event) =>
        event.type === "message.completed" &&
        event.data.message === null &&
        event.data.finishReason !== "tool-calls",
    ).length,
    visibleMessages: events.filter(
      (event) =>
        event.type === "message.completed" &&
        event.data.message !== null &&
        event.data.finishReason !== "tool-calls",
    ).length,
    completionsPerTurn: turns.map((turn) => completedTaskIds(turn).length),
  };
}

async function nextTurn(t: EveEvalContext, session: TaskEvalSessionDriver) {
  if (session.sessionId === undefined) throw new Error("Fanout has no parent session id.");
  const live = t.target.watchTurn(session.sessionId, {
    startIndex: requireSessionStreamIndex(session, "Batching benchmark"),
  });
  const turn = await live.result();
  turn.expectOk();
  return { session: live.session, turn };
}

function collectRequests(turn: EveEvalTurn, requests: Map<string, InputRequest>): void {
  for (const request of turn.inputRequests) {
    if (request.action.toolName === "release") requests.set(request.requestId, request);
  }
}

function completedTaskIds(turn: EveEvalTurn): string[] {
  return turn.events.flatMap((event) => {
    if (event.type !== "message.received") return [];
    return [...event.data.message.matchAll(COMPLETED_NOTIFICATION)].map(
      (match) => match[1] as string,
    );
  });
}
