import { defineEval, type EveEvalContext, type EveEvalTurn, type InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";

const FAN_IN_SIZE = 2;
const MAX_WAKE_TURNS = 8;
const FAN_IN_CALLS = [
  { callId: "task-fan-in-1", marker: "TASK-FAN-IN-1" },
  { callId: "task-fan-in-2", marker: "TASK-FAN-IN-2" },
] as const;

type FanInMarker = (typeof FAN_IN_CALLS)[number]["marker"];

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

    const tasksByMarker = backgroundTasksByMarker(started);
    const taskIds = [...tasksByMarker.values()];
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
    const marker1 = "TASK-FAN-IN-1";
    const marker2 = "TASK-FAN-IN-2";
    const marker1TaskId = requireMappedValue(tasksByMarker, marker1, "background task");
    const marker2TaskId = requireMappedValue(tasksByMarker, marker2, "background task");
    const marker1Request = requireMappedValue(blocked.requestsByMarker, marker1, "release request");
    const marker2Request = requireMappedValue(blocked.requestsByMarker, marker2, "release request");

    const firstReleased = await blocked.session.respond([
      {
        optionId: "approve",
        requestId: marker2Request.requestId,
      },
    ]);
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
      [
        { marker: marker1, status: "input_required", taskId: marker1TaskId },
        { marker: marker2, status: "completed", taskId: marker2TaskId },
      ],
      "marker 2 completes its task while marker 1 remains blocked",
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
    const secondReleased = await waiting.session.respond([
      {
        optionId: "approve",
        requestId: marker1Request.requestId,
      },
    ]);
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
      [
        { marker: marker1, status: "completed", taskId: marker1TaskId },
        { marker: marker2, status: "completed", taskId: marker2TaskId },
      ],
      "final join observes both exact tasks completed with their own markers",
    );
    t.noFailedActions();
  },
});

async function requireExactPeek(
  t: EveEvalContext,
  call: EveEvalTurn["toolCalls"][number] | undefined,
  taskIds: readonly string[],
  expectedTasks: readonly ExpectedTask[],
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
      return (
        JSON.stringify([...inputIds].sort()) === JSON.stringify(expected) &&
        JSON.stringify(outputIds) === JSON.stringify(expected) &&
        expectedTasks.every((expectedTask) => {
          const task = tasks.find(
            (candidate) => Reflect.get(candidate ?? {}, "taskId") === expectedTask.taskId,
          );
          return taskMatchesExpected(task, expectedTask);
        })
      );
    }, description),
  );
}

interface ExpectedTask {
  readonly marker: FanInMarker;
  readonly status: "completed" | "input_required";
  readonly taskId: string;
}

function taskMatchesExpected(task: unknown, expected: ExpectedTask): boolean {
  if (Reflect.get(task ?? {}, "status") !== expected.status) return false;
  if (expected.status === "completed") {
    const lastOutput = Reflect.get(task ?? {}, "lastOutput");
    return (
      Reflect.get(lastOutput ?? {}, "type") === "result" &&
      Reflect.get(lastOutput ?? {}, "data") === `FANOUT-COMPLETE:${expected.marker}`
    );
  }
  const inputRequests = Reflect.get(task ?? {}, "inputRequests");
  if (!Array.isArray(inputRequests)) return false;
  const release = inputRequests.find(
    (request) => Reflect.get(Reflect.get(request ?? {}, "action") ?? {}, "toolName") === "release",
  );
  const action = Reflect.get(release ?? {}, "action");
  return Reflect.get(Reflect.get(action ?? {}, "input") ?? {}, "marker") === expected.marker;
}

interface BlockedFanIn {
  readonly requestsByMarker: ReadonlyMap<FanInMarker, InputRequest>;
  readonly session: TaskEvalSessionDriver;
}

async function waitForReleaseRequests(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  initialTurn: EveEvalTurn,
  expected: number,
): Promise<BlockedFanIn> {
  const requestsByMarker = new Map<FanInMarker, InputRequest>();
  let session = initialSession;
  collectReleaseRequests(initialTurn.inputRequests, requestsByMarker);
  for (
    let attempt = 0;
    attempt < MAX_WAKE_TURNS && requestsByMarker.size < expected;
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
  if (requestsByMarker.size !== expected) {
    throw new Error(
      `Expected ${expected} marked release requests; received ${requestsByMarker.size}.`,
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
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Fan-in message wait"),
    });
    const turn = await live.result();
    observedTurns.push(turn);
    session = live.session;
    if ((turn.message ?? "").includes(token)) return { observedTurns, session, turn };
  }
  throw new Error(`No turn carried "${token}" after ${MAX_WAKE_TURNS} turns.`);
}

function backgroundTasksByMarker(turn: EveEvalTurn): ReadonlyMap<FanInMarker, string> {
  const tasksByMarker = new Map<FanInMarker, string>();
  for (const event of turn.events) {
    if (event.type !== "subagent.completed" || event.data.backgroundTask === undefined) continue;
    const fanInCall = FAN_IN_CALLS.find(({ callId }) => callId === event.data.callId);
    if (fanInCall !== undefined) {
      tasksByMarker.set(fanInCall.marker, event.data.backgroundTask.taskId);
    }
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
