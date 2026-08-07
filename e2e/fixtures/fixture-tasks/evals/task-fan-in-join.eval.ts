import { defineEval, type EveEvalContext, type EveEvalTurn, type InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import type { TaskEvalSessionDriver } from "./shared.js";

const FAN_IN_SIZE = 2;
const MAX_WAKE_TURNS = 8;

/**
 * The join contract: the framework delivers one
 * wake per ready transition and the model decides sufficiency. On every
 * wake the scripted model peeks both tasks; with one task released it must
 * answer WAITING, and only after the second completes may it answer
 * COMPLETE from a peek showing both tasks completed.
 */
export default defineEval({
  description:
    "Two background tasks joined across completion wakes: peek on every wake, final answer only when all are completed.",
  async test(t) {
    const started = await t.send("TASK-FAN-IN");
    started.expectOk();
    started.messageIncludes("TASK-FAN-IN-STARTED");
    started.calledSubagent("fanout-worker", { count: FAN_IN_SIZE });

    const taskIds = backgroundTaskIds(started);
    await t.require(
      taskIds,
      satisfies(
        (ids: readonly string[]) => ids.length === FAN_IN_SIZE && new Set(ids).size === FAN_IN_SIZE,
        `${FAN_IN_SIZE} distinct background task receipts`,
      ),
    );

    const blocked = await waitForReleaseRequests(t, t, started, FAN_IN_SIZE);

    // Release one task only: its completion wake must produce a peek that
    // still sees the other task blocked, so the model holds the answer.
    // The wake may coalesce into the respond turn or arrive on its own.
    const [firstRequest, secondRequest] = blocked.requests;
    if (firstRequest === undefined || secondRequest === undefined) {
      throw new Error("Fan-in did not surface two release requests.");
    }
    const firstReleased = await blocked.session.respond({
      optionId: "approve",
      requestId: firstRequest.requestId,
    });
    firstReleased.expectOk();

    const waiting = await waitForTurnMessage(
      t,
      blocked.session,
      "TASK-FAN-IN-WAITING",
      firstReleased,
    );
    const waitingPeek = waiting.turn.toolCalls.find((call) => call.name === "task_peek");
    await requireExactPeek(
      t,
      waitingPeek,
      taskIds,
      ["completed", "input_required"],
      "first completion keeps the other task blocked",
    );
    for (const turn of waiting.observedTurns) {
      await t.require(
        turn.message ?? "",
        satisfies(
          (message) => !String(message).includes("TASK-FAN-IN-COMPLETE"),
          "no final answer before every task completed",
        ),
      );
    }

    // Release the second task: the next peek sees both completed and the
    // model may finally answer.
    const secondReleased = await waiting.session.respond({
      optionId: "approve",
      requestId: secondRequest.requestId,
    });
    secondReleased.expectOk();

    const complete = await waitForTurnMessage(
      t,
      waiting.session,
      "TASK-FAN-IN-COMPLETE",
      secondReleased,
    );
    const completePeek = complete.turn.toolCalls.find((call) => call.name === "task_peek");
    await requireExactPeek(
      t,
      completePeek,
      taskIds,
      ["completed", "completed"],
      "final join observes both exact tasks completed",
    );
    t.noFailedActions();
  },
});

async function requireExactPeek(
  t: EveEvalContext,
  call: EveEvalTurn["toolCalls"][number] | undefined,
  taskIds: readonly string[],
  statuses: readonly string[],
  description: string,
): Promise<void> {
  await t.require(
    { input: call?.input, output: call?.output },
    satisfies((subject: { readonly input: unknown; readonly output: unknown }) => {
      const inputIds = Reflect.get(subject.input ?? {}, "taskIds");
      const tasks = Reflect.get(subject.output ?? {}, "tasks");
      if (!Array.isArray(inputIds) || !Array.isArray(tasks)) return false;
      const expected = [...taskIds].sort();
      const outputIds = tasks.map((task) => Reflect.get(task, "taskId")).sort();
      const outputStatuses = tasks.map((task) => Reflect.get(task, "status")).sort();
      return (
        JSON.stringify([...inputIds].sort()) === JSON.stringify(expected) &&
        JSON.stringify(outputIds) === JSON.stringify(expected) &&
        JSON.stringify(outputStatuses) === JSON.stringify([...statuses].sort())
      );
    }, description),
  );
}

interface BlockedFanIn {
  readonly requests: readonly InputRequest[];
  readonly session: TaskEvalSessionDriver;
}

async function waitForReleaseRequests(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  initialTurn: EveEvalTurn,
  expected: number,
): Promise<BlockedFanIn> {
  const requests = new Map<string, InputRequest>();
  let session = initialSession;
  collectReleaseRequests(initialTurn.inputRequests, requests);
  for (let attempt = 0; attempt < MAX_WAKE_TURNS && requests.size < expected; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Fan-in has no parent session id.");
    const live = t.target.watchTurn(sessionId, { startIndex: session.state.streamIndex });
    const turn = await live.result();
    collectReleaseRequests(turn.inputRequests, requests);
    session = live.session;
  }
  if (requests.size !== expected) {
    throw new Error(`Expected ${expected} release requests; received ${requests.size}.`);
  }
  return { requests: [...requests.values()], session };
}

function collectReleaseRequests(
  inputRequests: readonly InputRequest[],
  requests: Map<string, InputRequest>,
): void {
  for (const request of inputRequests) {
    if (request.action.toolName === "release") requests.set(request.requestId, request);
  }
}

interface ObservedTurnMessage {
  readonly observedTurns: readonly EveEvalTurn[];
  readonly session: TaskEvalSessionDriver;
  readonly turn: EveEvalTurn;
}

/**
 * Finds the first turn whose reply carries `token`, starting with an
 * already-consumed turn (a wake can coalesce into a respond turn) before
 * watching for later server-initiated turns.
 */
async function waitForTurnMessage(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  token: string,
  initialTurn: EveEvalTurn,
): Promise<ObservedTurnMessage> {
  const observedTurns: EveEvalTurn[] = [initialTurn];
  let session = initialSession;
  if ((initialTurn.message ?? "").includes(token)) {
    return { observedTurns, session, turn: initialTurn };
  }
  for (let attempt = 0; attempt < MAX_WAKE_TURNS; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Fan-in has no parent session id.");
    const live = t.target.watchTurn(sessionId, { startIndex: session.state.streamIndex });
    const turn = await live.result();
    observedTurns.push(turn);
    session = live.session;
    if ((turn.message ?? "").includes(token)) return { observedTurns, session, turn };
  }
  throw new Error(`No turn carried "${token}" after ${MAX_WAKE_TURNS} turns.`);
}

function backgroundTaskIds(turn: EveEvalTurn): readonly string[] {
  return turn.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [event.data.backgroundTask.taskId]
      : [],
  );
}
