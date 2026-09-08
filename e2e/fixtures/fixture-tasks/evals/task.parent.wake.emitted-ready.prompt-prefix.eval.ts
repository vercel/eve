import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import { PREFIX_REQUEST, WORKER_COUNT } from "../agent/lib/prompt-prefix";
import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const WAITING = "task-prompt-prefix-waiting";
const COMPLETE = "task-prompt-prefix-complete";
const holdIntervalSchema = z.object({ startedAt: z.number(), completedAt: z.number() });

export default [false, true].map((laterTurn) =>
  defineTaskEval({
    description: `Five parallel background subagents preserve the parent prompt through completion (${laterTurn ? "later" : "first"} turn).`,
    transition: {
      primary: "task.parent.wake.emitted-ready",
      setup: [
        "task.dispatch.start.accepted-acknowledged",
        "task.lifecycle.complete.accepted-nonterminal",
      ],
      dimensions: { transport: "local", parentPhase: "parked" },
    },
    async test(t) {
      if (laterTurn) (await t.send("Say ready.")).expectOk();

      const started = await t.send(PREFIX_REQUEST);
      started.expectOk();
      await requirePromptStatus(t, started, [WAITING], "parallel task admission");
      started.calledSubagent("busy-worker", { count: WORKER_COUNT });
      started.eventsSatisfy("five workers launched in the same model step", (events) => {
        const launchSteps = events
          .filter((event) => event.type === "actions.requested")
          .flatMap((event) =>
            event.data.actions
              .filter((action) => action.kind === "tool-call" && action.toolName === "busy-worker")
              .map(() => `${event.data.turnId}:${event.data.stepIndex}`),
          );
        return launchSteps.length === WORKER_COUNT && new Set(launchSteps).size === 1;
      });

      const taskIds = backgroundTaskIds(started);
      await t.require(
        taskIds,
        satisfies(
          (ids: readonly string[]) => hasDistinctCount(ids, WORKER_COUNT),
          "five distinct background task receipts",
        ),
      );

      const parentTurns = await waitForAllWorkers(t, started);
      for (const taskId of taskIds) {
        t.event("message.received", {
          count: 1,
          data: {
            message: (message) =>
              typeof message === "string" &&
              message.includes(`Background task ${taskId} (`) &&
              message.includes(" is completed."),
          },
        });
      }

      const workerCalls = parentTurns.flatMap((turn) =>
        turn.events.flatMap((event) =>
          event.type === "subagent.called" && event.data.name === "busy-worker" ? [event.data] : [],
        ),
      );
      await t.require(
        workerCalls.map((call) => call.childSessionId),
        satisfies(
          (sessionIds: readonly string[]) => hasDistinctCount(sessionIds, WORKER_COUNT),
          "five distinct child sessions",
        ),
      );

      const children = await Promise.all(
        workerCalls.map((call) => t.target.watchTurn(call.childSessionId).result()),
      );
      const intervals = children.map((child) => {
        child.expectOk();
        child.calledTool("hold", { count: 1 });
        return holdIntervalSchema.parse(
          child.toolCalls.find((call) => call.name === "hold")?.output,
        );
      });
      await t.require(
        intervals,
        satisfies(
          (values: typeof intervals) =>
            Math.max(...values.map((value) => value.startedAt)) <
            Math.min(...values.map((value) => value.completedAt)),
          "all five child tool executions overlap",
        ),
      );

      t.noFailedActions();
    },
  }),
);

function backgroundTaskIds(turn: EveEvalTurn): string[] {
  return turn.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [event.data.backgroundTask.taskId]
      : [],
  );
}

function hasDistinctCount(values: readonly string[], count: number): boolean {
  return values.length === count && new Set(values).size === count;
}

async function requirePromptStatus(
  t: EveEvalContext,
  turn: EveEvalTurn,
  expected: readonly string[],
  boundary: string,
): Promise<void> {
  await t.require(
    turn.message,
    satisfies(
      (message: string | undefined) => message !== undefined && expected.includes(message),
      `prompt prefix survives ${boundary}`,
    ),
  );
}

async function waitForAllWorkers(t: EveEvalContext, started: EveEvalTurn): Promise<EveEvalTurn[]> {
  let session: TaskEvalSessionDriver = t;
  let turn = started;
  const turns = [started];

  for (let attempt = 0; attempt < WORKER_COUNT * 2 && turn.message !== COMPLETE; attempt += 1) {
    const live = t.target.watchTurn(started.sessionId, {
      startIndex: requireSessionStreamIndex(session, "Parallel task completion"),
    });
    turn = await live.result();
    turn.expectOk();
    await requirePromptStatus(t, turn, [WAITING, COMPLETE], "a task completion wake");
    turns.push(turn);
    session = live.session;
  }

  if (turn.message !== COMPLETE) {
    throw new Error(`Parent did not collect all ${WORKER_COUNT} background task results.`);
  }
  return turns;
}
