import type { EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import { PREFIX_REQUEST, WORKER_COUNT } from "../agent/lib/prompt-prefix";
import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

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
      await t.require(
        started.message,
        satisfies(
          (message: string | undefined) => message === "task-prompt-prefix-waiting",
          "prompt prefix survives parallel task admission",
        ),
      );
      started.calledSubagent("busy-worker", { count: WORKER_COUNT });
      started.eventsSatisfy("five workers launched in the same model step", (events) => {
        const steps = events
          .filter((event) => event.type === "actions.requested")
          .flatMap((event) =>
            event.data.actions
              .filter((action) => action.kind === "tool-call" && action.toolName === "busy-worker")
              .map(() => `${event.data.turnId}:${event.data.stepIndex}`),
          );
        return steps.length === WORKER_COUNT && new Set(steps).size === 1;
      });
      const taskIds = started.events.flatMap((event) =>
        event.type === "subagent.completed" && event.data.backgroundTask !== undefined
          ? [event.data.backgroundTask.taskId]
          : [],
      );
      await t.require(
        taskIds,
        satisfies(
          (ids: readonly string[]) =>
            ids.length === WORKER_COUNT && new Set(ids).size === WORKER_COUNT,
          "five distinct background task receipts",
        ),
      );

      let session: TaskEvalSessionDriver = t;
      let turn: EveEvalTurn = started;
      const parentTurns = [started];
      for (
        let attempt = 0;
        attempt < WORKER_COUNT * 2 && !(turn.message ?? "").includes("task-prompt-prefix-complete");
        attempt++
      ) {
        const live = t.target.watchTurn(started.sessionId, {
          startIndex: requireSessionStreamIndex(session, "Parallel task completion"),
        });
        turn = await live.result();
        parentTurns.push(turn);
        turn.expectOk();
        await t.require(
          turn.message,
          satisfies(
            (message: string | undefined) =>
              message === "task-prompt-prefix-waiting" || message === "task-prompt-prefix-complete",
            "prompt prefix survives a task completion wake",
          ),
        );
        session = live.session;
      }
      turn.messageIncludes("task-prompt-prefix-complete");
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
      const calls = parentTurns.flatMap((parent) =>
        parent.events.flatMap((event) =>
          event.type === "subagent.called" && event.data.name === "busy-worker" ? [event.data] : [],
        ),
      );
      await t.require(
        calls,
        satisfies(
          (entries: typeof calls) =>
            entries.length === WORKER_COUNT &&
            new Set(entries.map((entry) => entry.childSessionId)).size === WORKER_COUNT,
          "five distinct child sessions",
        ),
      );
      const children = await Promise.all(
        calls.map((call) => t.target.watchTurn(call.childSessionId).result()),
      );
      const intervals = children.map((child) => {
        child.expectOk();
        child.calledTool("hold", { count: 1 });
        return z
          .object({ startedAt: z.number(), completedAt: z.number() })
          .parse(child.toolCalls.find((call) => call.name === "hold")?.output);
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
