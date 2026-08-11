import { type EveEvalTurn, type InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import {
  requireSessionStreamIndex,
  sendAndFollowQueuedTurn,
  type TaskEvalSessionDriver,
} from "./shared.js";

const FANOUT_SIZE = 10;

/** The parent remains interactive while its background children await input. */
export default defineTaskEval({
  description: "A parent accepts a new tool-free turn while ten background children remain live.",
  transition: {
    primary: "task.parent-interaction.send.accepted-live-children",
    setup: ["task.dispatch.start.accepted-acknowledged", "task.input.require.accepted-valid-batch"],
    dimensions: { transport: "local", parentPhase: "active" },
  },
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
      blocked.requests.map((request) => ({
        optionId: "approve",
        requestId: request.requestId,
      })),
    );
    released.expectOk();
    t.noFailedActions();
  },
});

interface BlockedFanout {
  readonly requests: readonly InputRequest[];
  readonly session: TaskEvalSessionDriver;
}

async function waitForReleaseRequests(
  t: Parameters<typeof sendAndFollowQueuedTurn>[0],
  initialSession: TaskEvalSessionDriver,
  initialTurn: EveEvalTurn,
): Promise<BlockedFanout> {
  const requests = new Map<string, InputRequest>();
  let session = initialSession;
  collectReleaseRequests(initialTurn, requests);
  for (let attempt = 0; attempt < FANOUT_SIZE && requests.size < FANOUT_SIZE; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Task fanout has no parent session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Task fanout release wait"),
    });
    const turn = await live.result();
    collectReleaseRequests(turn, requests);
    session = live.session;
  }
  if (requests.size !== FANOUT_SIZE) {
    throw new Error(`Expected ${FANOUT_SIZE} release requests; received ${requests.size}.`);
  }
  return { requests: [...requests.values()], session };
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
