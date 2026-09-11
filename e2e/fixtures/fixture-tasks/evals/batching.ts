import { type EveEvalContext, type EveEvalTurn, type InputRequest } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  requireSessionStreamIndex,
  waitForChildResult,
  type TaskEvalSessionDriver,
} from "./shared.js";

/** Release children independently of parent wakes, retaining the entire parent stream suffix. */
export async function startBlockedFanout(t: EveEvalContext, count: number) {
  let session: TaskEvalSessionDriver = t;
  const started = await t.send("TASK-BATCHING-BENCHMARK");
  started.expectOk();
  started.noFailedActions();
  started.messageIncludes("TASK-FANOUT-STARTED");
  started.calledSubagent("fanout-worker", { count });
  const receipts = started.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [{ callId: event.data.callId, taskId: event.data.backgroundTask.taskId }]
      : [],
  );
  const taskIds = receipts.map(({ taskId }) => taskId);
  await t.require(
    { receipts: taskIds.length, distinct: new Set(taskIds).size },
    equals({ receipts: count, distinct: count }),
  );

  const setupEvents: EveEvalTurn["events"][number][] = [];
  const requests = new Map<string, InputRequest>();
  collectRequests(started);
  for (let attempt = 0; requests.size < count && attempt < count; attempt += 1) {
    collectRequests(await nextTurn());
  }

  const children = setupEvents.flatMap((event) => {
    if (event.type !== "subagent.called") return [];
    const action = setupEvents
      .flatMap((entry) => (entry.type === "actions.requested" ? entry.data.actions : []))
      .find((entry) => entry.callId === event.data.callId);
    const marker =
      typeof action?.input.message === "string"
        ? /FANOUT-WORKER-\d+/u.exec(action.input.message)?.[0]
        : undefined;
    const receipt = receipts.find(({ callId }) => callId === event.data.callId);
    if (marker === undefined || receipt === undefined) {
      throw new Error("Fanout child has no marked delegation and matching task receipt.");
    }
    return [
      {
        marker,
        taskId: receipt.taskId,
        sessionId: event.data.childSessionId,
        turnId: event.data.turnId,
      },
    ];
  });
  await t.require(
    {
      children: children.length,
      sessions: new Set(children.map((child) => child.sessionId)).size,
      tasks: children.map((child) => child.taskId).sort(),
      markers: children.map((child) => child.marker).sort(),
      creatingTurns: new Set(children.map((child) => child.turnId)).size,
    },
    equals({
      children: count,
      sessions: count,
      tasks: [...taskIds].sort(),
      markers: Array.from({ length: count }, (_, index) => `FANOUT-WORKER-${index + 1}`).sort(),
      creatingTurns: 1,
    }),
  );

  await t.require(
    {
      markers: [...requests.keys()].sort(),
      requestIds: new Set([...requests.values()].map((request) => request.requestId)).size,
    },
    equals({ markers: children.map((child) => child.marker).sort(), requestIds: count }),
  );
  const remaining = [...children];
  const completedChildren: EveEvalTurn[] = [];
  const parentTurns: EveEvalTurn[] = [];
  const completionTurns: EveEvalTurn[] = [];

  return {
    started,
    taskIds,
    completedChildren,
    parentTurns,
    completionTurns,
    async completeNext(batchSize: number) {
      const batch = remaining.splice(0, batchSize);
      await t.require(batch.length, equals(batchSize));
      // respond() waits for a parent boundary that the cohort barrier deliberately withholds.
      await post({
        inputResponses: batch.map(({ marker }) => ({
          requestId: requests.get(marker)!.requestId,
          optionId: "approve",
        })),
      });
      for (const child of batch) {
        completedChildren.push(
          await waitForChildResult(t, child.sessionId, `FANOUT-COMPLETE:${child.marker}`),
        );
      }
      if (remaining.length === 0) {
        for (let attempt = 0; attempt < count + 3; attempt += 1) {
          const turn = observe(await nextTurn());
          if (completedTaskIds(turn).length > 0) {
            await t.require(completedTaskIds(turn).sort(), equals([...taskIds].sort()));
            return;
          }
          turn.notEvent("step.started");
        }
        throw new Error("The settled cohort produced no completion report.");
      }
    },
    async send(message: string) {
      await post({ message, turnPolicy: "queue" });
      for (let attempt = 0; attempt < count + 3; attempt += 1) {
        const turn = observe(await nextTurn());
        await t.require(completedTaskIds(turn), equals([]));
        if (
          turn.events.some(
            (event) => event.type === "message.received" && event.data.message === message,
          )
        )
          return turn;
        turn.notEvent("step.started");
      }
      throw new Error("The user message did not run while a sibling was blocked.");
    },
  };

  function collectRequests(turn: EveEvalTurn) {
    setupEvents.push(...turn.events);
    for (const request of turn.inputRequests) {
      if (request.action.toolName !== "release") continue;
      const marker = request.action.input.marker;
      if (
        typeof marker !== "string" ||
        (requests.has(marker) && requests.get(marker)!.requestId !== request.requestId)
      ) {
        throw new Error("Fanout release requests must have distinct child markers.");
      }
      requests.set(marker, request);
    }
  }

  function observe(turn: EveEvalTurn) {
    parentTurns.push(turn);
    if (completedTaskIds(turn).length > 0) completionTurns.push(turn);
    return turn;
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
    await t.require(response.status, equals(202));
    await response.body?.cancel();
  }

  async function nextTurn() {
    const live = t.target.watchTurn(started.sessionId, {
      startIndex: requireSessionStreamIndex(session, "Cohort parent"),
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
