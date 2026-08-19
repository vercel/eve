import { type EveEvalContext, type EveEvalTurn, type InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";

const FANOUT_SIZE = 3;
const COMPLETED_NOTIFICATION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

/** Every completed child emits one task-addressed ready notification to its parent. */
export default defineTaskEval({
  description:
    "Three completed children emit exactly one parent notification each, with no duplicate or unknown task ids.",
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
    const started = await t.send("TASK-PARENT-WAKE-UPDATES");
    started.expectOk();
    started.calledSubagent("fanout-worker", { count: FANOUT_SIZE });

    const taskIds = backgroundTaskIds(started);
    await t.require(
      taskIds,
      satisfies(
        (ids: readonly string[]) => ids.length === FANOUT_SIZE && new Set(ids).size === FANOUT_SIZE,
        `${FANOUT_SIZE} distinct background task receipts`,
      ),
    );

    const blocked = await waitForReleaseRequests(t, t, started);
    const released = await blocked.session.respond(
      blocked.requests.map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    );
    released.expectOk();

    const notifiedTaskIds = [
      ...completedNotificationTaskIds(started),
      ...blocked.observedTurns.flatMap(completedNotificationTaskIds),
      ...completedNotificationTaskIds(released),
    ];
    const observedKnownTaskIds = new Set(
      notifiedTaskIds.filter((taskId) => taskIds.includes(taskId)),
    );
    let session = blocked.session;
    for (
      let attempt = 0;
      attempt < FANOUT_SIZE && observedKnownTaskIds.size < FANOUT_SIZE;
      attempt += 1
    ) {
      const sessionId = session.sessionId;
      if (sessionId === undefined) throw new Error("Task fanout has no parent session id.");
      const live = t.target.watchTurn(sessionId, {
        startIndex: requireSessionStreamIndex(session, "Task fanout notification wait"),
      });
      const turn = await live.result();
      for (const taskId of completedNotificationTaskIds(turn)) {
        notifiedTaskIds.push(taskId);
        if (taskIds.includes(taskId)) observedKnownTaskIds.add(taskId);
      }
      session = live.session;
    }

    await t.require(
      notifiedTaskIds,
      satisfies(
        (ids: readonly string[]) =>
          ids.length === FANOUT_SIZE &&
          JSON.stringify([...ids].sort()) === JSON.stringify([...taskIds].sort()),
        "exactly one completed notification for every known task and none for unknown task ids",
      ),
    );
    t.noFailedActions();
  },
});

interface BlockedFanout {
  readonly observedTurns: readonly EveEvalTurn[];
  readonly requests: readonly InputRequest[];
  readonly session: TaskEvalSessionDriver;
}

async function waitForReleaseRequests(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  initialTurn: EveEvalTurn,
): Promise<BlockedFanout> {
  const requests = new Map<string, InputRequest>();
  const observedTurns = [initialTurn];
  let session = initialSession;
  collectReleaseRequests(initialTurn, requests);
  for (let attempt = 0; attempt < FANOUT_SIZE && requests.size < FANOUT_SIZE; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Task fanout has no parent session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Task fanout release wait"),
    });
    const turn = await live.result();
    observedTurns.push(turn);
    collectReleaseRequests(turn, requests);
    session = live.session;
  }
  if (requests.size !== FANOUT_SIZE) {
    throw new Error(`Expected ${FANOUT_SIZE} release requests; received ${requests.size}.`);
  }
  return { observedTurns, requests: [...requests.values()], session };
}

function collectReleaseRequests(turn: EveEvalTurn, requests: Map<string, InputRequest>): void {
  for (const request of turn.inputRequests) {
    if (request.action.toolName === "release") requests.set(request.requestId, request);
  }
}

function backgroundTaskIds(turn: EveEvalTurn): readonly string[] {
  return turn.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [event.data.backgroundTask.taskId]
      : [],
  );
}

function completedNotificationTaskIds(turn: EveEvalTurn): readonly string[] {
  return turn.events.flatMap((event) => {
    if (event.type !== "message.received") return [];
    return [...messageText(event.data.message).matchAll(COMPLETED_NOTIFICATION)].map(
      (match) => match[1] as string,
    );
  });
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .flatMap((part) =>
      part !== null &&
      typeof part === "object" &&
      Reflect.get(part, "type") === "text" &&
      typeof Reflect.get(part, "text") === "string"
        ? [Reflect.get(part, "text") as string]
        : [],
    )
    .join("\n");
}
