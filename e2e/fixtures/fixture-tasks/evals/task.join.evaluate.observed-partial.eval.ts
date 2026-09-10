import type { EveEvalTurn, InputRequest } from "eve/evals";
import { equals } from "eve/evals/expect";

import { completedTaskIds, completionMetrics } from "./batching.js";
import { defineTaskEval } from "./task-transition.js";
import {
  requireSessionStreamIndex,
  waitForChildResult,
  type TaskEvalSessionDriver,
} from "./shared.js";

const STATUS_REQUEST = "TASK-FAN-IN-STATUS";
const MARKERS = ["TASK-FAN-IN-1", "TASK-FAN-IN-2"] as const;

export default defineTaskEval({
  description:
    "An independent user turn observes an incomplete join after one child completes while its sibling still awaits input; only the settled cohort triggers a completion turn.",
  transition: {
    primary: "task.join.evaluate.observed-partial",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.input.require.accepted-valid-batch",
      "task.input.answer.accepted-complete",
      "task.lifecycle.complete.accepted-nonterminal",
      "task.parent.wake.noop-pending-cohort",
    ],
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const started = (await t.send("TASK-FAN-IN")).expectOk();
    started.messageIncludes("TASK-FAN-IN-STARTED");
    started.calledSubagent("fanout-worker", { count: MARKERS.length });
    const children = MARKERS.map((marker) => {
      const callId = marker.toLowerCase();
      const called = started.events.find(
        (event) => event.type === "subagent.called" && event.data.callId === callId,
      );
      const receipt = started.events.find(
        (event) => event.type === "subagent.completed" && event.data.callId === callId,
      );
      if (
        called?.type !== "subagent.called" ||
        receipt?.type !== "subagent.completed" ||
        receipt.data.backgroundTask === undefined
      ) {
        throw new Error(`No child session and task receipt for ${marker}.`);
      }
      return {
        marker,
        sessionId: called.data.childSessionId,
        taskId: receipt.data.backgroundTask.taskId,
        turnId: called.data.turnId,
      };
    });
    const taskIds = children.map((child) => child.taskId);
    await t.require(
      {
        tasks: new Set(taskIds).size,
        sessions: new Set(children.map((child) => child.sessionId)).size,
        creatingTurns: new Set(children.map((child) => child.turnId)).size,
      },
      equals({ tasks: 2, sessions: 2, creatingTurns: 1 }),
    );

    let session: TaskEvalSessionDriver = t;
    const requests = new Map<string, InputRequest>();
    collectRequests(started);
    for (let attempt = 0; requests.size < 2 && attempt < 8; attempt += 1)
      collectRequests(await nextTurn());
    await t.require([...requests.keys()].sort(), equals([...MARKERS]));
    await t.require(
      new Set([...requests.values()].map((request) => request.requestId)).size,
      equals(2),
    );

    await release("TASK-FAN-IN-2");
    await waitForChildResult(t, children[1]!.sessionId, "FANOUT-COMPLETE:TASK-FAN-IN-2");
    await post({ message: STATUS_REQUEST, turnPolicy: "queue" });
    const partial: EveEvalTurn[] = [];
    let answered = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const turn = await nextTurn();
      partial.push(turn);
      await t.require(completedTaskIds(turn), equals([]));
      if (
        turn.events.some(
          (event) => event.type === "message.received" && event.data.message === STATUS_REQUEST,
        )
      ) {
        await t.require(turn.message, equals("TASK-FAN-IN-WAITING"));
        turn.usedNoTools();
        answered = true;
        break;
      }
      turn.notEvent("step.started");
    }
    await t.require(answered, equals(true));
    await t.require(completionMetrics(partial).modelSteps, equals(1));
    const pendingRequestId = requests.get("TASK-FAN-IN-1")!.requestId;
    t.check(
      partial
        .flatMap((turn) => turn.events)
        .some(
          (event) =>
            event.type === "input.resolved" &&
            event.data.resolutions.some((resolution) => resolution.requestId === pendingRequestId),
        ),
      equals(false),
    ).label("the other sibling still awaits its own approval during the user answer");

    await release("TASK-FAN-IN-1");
    await waitForChildResult(t, children[0]!.sessionId, "FANOUT-COMPLETE:TASK-FAN-IN-1");
    let reported = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const turn = await nextTurn();
      if (completedTaskIds(turn).length > 0) {
        await t.require(completedTaskIds(turn).sort(), equals([...taskIds].sort()));
        await t.require(turn.message, equals("TASK-FAN-IN-COMPLETE"));
        turn.event("step.started", { count: 1 });
        reported = true;
        break;
      }
      turn.notEvent("step.started");
    }
    await t.require(reported, equals(true));
    t.calledSubagent("fanout-worker", { count: 2 });
    t.notCalledTool("task_peek");
    t.noFailedActions();

    function collectRequests(turn: EveEvalTurn) {
      for (const request of turn.inputRequests) {
        const marker = request.action.input.marker;
        if (request.action.toolName === "release" && typeof marker === "string")
          requests.set(marker, request);
      }
    }

    async function release(marker: string) {
      await post({
        inputResponses: [{ optionId: "approve", requestId: requests.get(marker)!.requestId }],
      });
    }

    async function post(body: unknown) {
      const response = await t.target.fetch(
        `/eve/v1/session/${encodeURIComponent(started.sessionId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: t.signal,
        },
      );
      await response.body?.cancel();
      await t.require(response.status, equals(202));
    }

    async function nextTurn() {
      const live = t.target.watchTurn(started.sessionId, {
        startIndex: requireSessionStreamIndex(session, "Partial join"),
      });
      const turn = (await live.result()).expectOk();
      session = live.session;
      return turn;
    }
  },
});
