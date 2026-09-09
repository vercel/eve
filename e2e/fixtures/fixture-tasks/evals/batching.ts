import { type EveEvalContext, type EveEvalTurn, type InputRequest } from "eve/evals";
import { equals } from "eve/evals/expect";

import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";

/** Start the benchmark and wait until every child is blocked on its release tool. */
export async function startBlockedFanout(t: EveEvalContext, count: number) {
  let session: TaskEvalSessionDriver = t;
  const started = await t.send("TASK-BATCHING-BENCHMARK");
  started.expectOk();
  started.calledSubagent("fanout-worker", { count });
  const taskIds = started.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [event.data.backgroundTask.taskId]
      : [],
  );
  await t.require(
    { receipts: taskIds.length, distinct: new Set(taskIds).size },
    equals({ receipts: count, distinct: count }),
  );

  const requests = new Map<string, InputRequest>();
  collectRequests(started);
  for (let attempt = 0; requests.size < count && attempt < count; attempt += 1) {
    collectRequests(await nextTurn());
  }
  await t.require({ releaseRequests: requests.size }, equals({ releaseRequests: count }));
  const remaining = [...requests.values()];

  // Only completion turns contribute to measurements; setup and user turns do not.
  const completionTurns: EveEvalTurn[] = [];
  const deliveredCount = () => completionTurns.flatMap(completedTaskIds).length;
  return {
    taskIds,
    completionTurns,
    async completeNext(batchSize: number) {
      const batch = remaining.splice(0, batchSize);
      await t.require({ releaseRequests: batch.length }, equals({ releaseRequests: batchSize }));
      observe(
        await session.respond(batch.map(({ requestId }) => ({ requestId, optionId: "approve" }))),
      );
      const expected = count - remaining.length;
      for (let attempt = 0; deliveredCount() < expected && attempt < count; attempt += 1) {
        observe(await nextTurn());
      }
      await t.require(
        { completedDeliveries: deliveredCount() },
        equals({ completedDeliveries: expected }),
      );
    },
    async send(message: string) {
      return observe(await session.send(message));
    },
  };

  function collectRequests(turn: EveEvalTurn) {
    for (const request of turn.inputRequests) {
      if (request.action.toolName === "release") requests.set(request.requestId, request);
    }
  }

  function observe(turn: EveEvalTurn) {
    turn.expectOk();
    if (completedTaskIds(turn).length > 0) completionTurns.push(turn);
    return turn;
  }

  async function nextTurn() {
    if (session.sessionId === undefined) throw new Error("Fanout has no parent session id.");
    const live = t.target.watchTurn(session.sessionId, {
      startIndex: requireSessionStreamIndex(session, "Batching benchmark"),
    });
    const turn = await live.result();
    session = live.session;
    return turn.expectOk();
  }
}

export function completedTaskIds(turn: EveEvalTurn): string[] {
  const notification = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;
  return turn.events.flatMap((event) => {
    if (event.type !== "message.received") return [];
    return [...event.data.message.matchAll(notification)].map((match) => match[1]!);
  });
}

export function completionMetrics(turns: readonly EveEvalTurn[]) {
  const events = turns.flatMap((turn) => turn.events);
  const messages = events
    .filter((event) => event.type === "message.completed")
    .filter((event) => event.data.finishReason !== "tool-calls");
  return {
    parentTurns: turns.length,
    modelSteps: events.filter((event) => event.type === "step.started").length,
    silentMessages: messages.filter((event) => event.data.message === null).length,
    visibleMessages: messages.filter((event) => event.data.message !== null).length,
    completionsPerTurn: turns.map((turn) => completedTaskIds(turn).length),
  };
}
