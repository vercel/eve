import { type EveEvalContext, type EveEvalTurn, type InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";

const FAN_IN_SIZE = 2;
const MAX_WAKE_TURNS = 8;
const FAN_IN_CALLS = [
  { callId: "task-fan-in-1", marker: "TASK-FAN-IN-1" },
  { callId: "task-fan-in-2", marker: "TASK-FAN-IN-2" },
] as const;

type FanInMarker = (typeof FAN_IN_CALLS)[number]["marker"];

/** A join completes after result-bearing notifications cover its exact task set. */
export default defineTaskEval({
  description: "A join observes both exact tasks completed before answering COMPLETE.",
  transition: {
    primary: "task.join.evaluate.observed-all-terminal",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.input.require.accepted-valid-batch",
      "task.input.answer.accepted-complete",
      "task.lifecycle.complete.accepted-nonterminal",
      "task.parent.wake.emitted-ready",
    ],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const started = await t.send("TASK-FAN-IN");
    started.expectOk();
    started.calledSubagent("fanout-worker", { count: FAN_IN_SIZE });

    const tasksByMarker = backgroundTasksByMarker(started);
    const taskIds = [...tasksByMarker.values()];
    await t.require(
      taskIds,
      satisfies(
        (ids: readonly string[]) => ids.length === FAN_IN_SIZE && new Set(ids).size === FAN_IN_SIZE,
        `${FAN_IN_SIZE} distinct background task receipts`,
      ),
    );
    const blocked = await waitForReleaseRequests(t, t, started);

    const released = await blocked.session.respond(
      FAN_IN_CALLS.map(({ marker }) => ({
        optionId: "approve",
        requestId: requireMappedValue(blocked.requestsByMarker, marker, "release request")
          .requestId,
      })),
    );
    released.expectOk();

    const complete = await waitForTurnMessage(t, blocked.session, "TASK-FAN-IN-COMPLETE", released);
    complete.notCalledTool("task_peek");
    for (const { marker } of FAN_IN_CALLS) {
      const taskId = requireMappedValue(tasksByMarker, marker, "background task");
      t.event("message.received", {
        count: 1,
        data: {
          message: (message) =>
            typeof message === "string" &&
            message.includes(`Background task ${taskId} (`) &&
            message.includes(" is completed.") &&
            message.includes(`FANOUT-COMPLETE:${marker}`),
        },
      });
    }
    t.notCalledTool("task_peek");
    t.noFailedActions();
  },
});

interface BlockedFanIn {
  readonly requestsByMarker: ReadonlyMap<FanInMarker, InputRequest>;
  readonly session: TaskEvalSessionDriver;
}

async function waitForReleaseRequests(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  initialTurn: EveEvalTurn,
): Promise<BlockedFanIn> {
  const requestsByMarker = new Map<FanInMarker, InputRequest>();
  let session = initialSession;
  collectReleaseRequests(initialTurn.inputRequests, requestsByMarker);
  for (
    let attempt = 0;
    attempt < MAX_WAKE_TURNS && requestsByMarker.size < FAN_IN_SIZE;
    attempt += 1
  ) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Fan-in has no parent session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Fan-in release wait"),
    });
    const turn = await live.result();
    collectReleaseRequests(turn.inputRequests, requestsByMarker);
    session = live.session;
  }
  if (requestsByMarker.size !== FAN_IN_SIZE) {
    throw new Error(
      `Expected ${FAN_IN_SIZE} marked release requests; received ${requestsByMarker.size}.`,
    );
  }
  return { requestsByMarker, session };
}

function collectReleaseRequests(
  inputRequests: readonly InputRequest[],
  requestsByMarker: Map<FanInMarker, InputRequest>,
): void {
  for (const request of inputRequests) {
    if (request.action.toolName !== "release") continue;
    const marker = request.action.input.marker;
    if (isFanInMarker(marker)) requestsByMarker.set(marker, request);
  }
}

function isFanInMarker(value: unknown): value is FanInMarker {
  return FAN_IN_CALLS.some(({ marker }) => marker === value);
}

async function waitForTurnMessage(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  token: string,
  initialTurn: EveEvalTurn,
): Promise<EveEvalTurn> {
  if ((initialTurn.message ?? "").includes(token)) return initialTurn;
  let session = initialSession;
  for (let attempt = 0; attempt < MAX_WAKE_TURNS; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Fan-in has no parent session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Fan-in message wait"),
    });
    const turn = await live.result();
    session = live.session;
    if ((turn.message ?? "").includes(token)) return turn;
  }
  throw new Error(`No turn carried "${token}" after ${MAX_WAKE_TURNS} turns.`);
}

function backgroundTasksByMarker(turn: EveEvalTurn): ReadonlyMap<FanInMarker, string> {
  const tasksByMarker = new Map<FanInMarker, string>();
  for (const event of turn.events) {
    if (event.type !== "subagent.completed" || event.data.backgroundTask === undefined) continue;
    const fanInCall = FAN_IN_CALLS.find(({ callId }) => callId === event.data.callId);
    if (fanInCall !== undefined)
      tasksByMarker.set(fanInCall.marker, event.data.backgroundTask.taskId);
  }
  return tasksByMarker;
}

function requireMappedValue<T>(
  values: ReadonlyMap<FanInMarker, T>,
  marker: FanInMarker,
  description: string,
): T {
  const value = values.get(marker);
  if (value === undefined) throw new Error(`Fan-in has no ${description} for ${marker}.`);
  return value;
}
