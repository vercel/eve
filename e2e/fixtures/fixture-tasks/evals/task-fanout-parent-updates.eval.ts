import { defineEval, type EveEvalTurn, type InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { sendAndFollowQueuedTurn, type TaskEvalSessionDriver } from "./shared.js";

const FANOUT_SIZE = 10;

/** Many background tasks complete independently and publish lifecycle updates to their parent. */
export default defineEval({
  description:
    "A ten-task fanout returns distinct receipts and sends every completion update to the parent session.",
  async test(t) {
    const started = await t.send("TASK-FANOUT-PARENT-UPDATES");
    started.expectOk();
    started.messageIncludes("TASK-FANOUT-STARTED");
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
    const interactive = await sendAndFollowQueuedTurn(
      t,
      "TASK-FANOUT-INTERACTIVE-CHECK",
      blocked.session,
    );
    interactive.turn.expectOk();
    interactive.turn.messageIncludes("TASK-FANOUT-INTERACTIVE-OK");
    interactive.turn.usedNoTools();

    const released = await interactive.session.respond(
      ...blocked.requests.map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    );
    released.expectOk();

    const updated = new Set([
      ...completedTaskUpdates(started, taskIds),
      ...blocked.observedTurns.flatMap((turn) => completedTaskUpdates(turn, taskIds)),
      ...interactive.observedTurns.flatMap((turn) => completedTaskUpdates(turn, taskIds)),
      ...completedTaskUpdates(released, taskIds),
    ]);
    let startIndex = interactive.session.state.streamIndex;
    for (let attempt = 0; attempt < FANOUT_SIZE && updated.size < FANOUT_SIZE; attempt += 1) {
      const sessionId = t.sessionId;
      if (sessionId === undefined) throw new Error("Task fanout has no parent session id.");
      const live = t.target.watchTurn(sessionId, { startIndex });
      const turn = await live.result();
      for (const taskId of completedTaskUpdates(turn, taskIds)) updated.add(taskId);
      startIndex = live.session.state.streamIndex;
    }

    await t.require(
      [...updated],
      satisfies(
        (ids: readonly string[]) => ids.length === FANOUT_SIZE,
        "every fanout task sends a completed update to the parent session",
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
  t: Parameters<typeof sendAndFollowQueuedTurn>[0],
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
    const live = t.target.watchTurn(sessionId, { startIndex: session.state.streamIndex });
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

function completedTaskUpdates(turn: EveEvalTurn, taskIds: readonly string[]): readonly string[] {
  const messages = turn.events.flatMap((event) =>
    event.type === "message.received" ? [messageText(event.data.message)] : [],
  );
  return taskIds.filter((taskId) =>
    messages.some(
      (message) => message.includes(`Background task ${taskId} `) && message.includes("completed"),
    ),
  );
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
