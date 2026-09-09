import type { EveEvalContext, EveEvalLiveTurn, EveEvalSession, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export const TASK_COUNT = 3;
export const QUESTION =
  "Alice is packing seven boxes with eight jars in each. How many jars is that? Reply with just the number.";

const MIN_BACKGROUND_TASKS = 2;
const RESULTS = [/\boranges\b/iu, /\bpears\b/iu, /\bapples\b/iu];
const COMPLETION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

interface ReportingRun {
  readonly sessionId: string;
  readonly taskIds: readonly string[];
  readonly observed: Set<string>;
  readonly childSessionIds: Set<string>;
  readonly wakes: { turn: EveEvalTurn; completed: number; settled: boolean }[];
  session: EveEvalSession | EveEvalContext;
}

export async function startWarehouseLookups(t: EveEvalContext): Promise<ReportingRun> {
  const started =
    await t.send(`Please find the inventory item at each of our three sample warehouses using the built-in agent tool. Start all three lookups in the background without waiting for their results. Delegate the lookups instead of calling probe yourself.

1. "Call probe with check=first and report its result value."
2. "Call probe with check=second and report its result value."
3. "Call probe with check=third and report its result value."`);
  started.expectOk();
  started.calledSubagent("agent", { count: TASK_COUNT }).soft().label("no repeated delegation");
  await t.require(
    started,
    satisfies(
      hasPostReceiptAcknowledgement,
      "an acknowledgement follows all background task receipts",
    ),
  );
  await t.require(
    started.message,
    satisfies(
      (message: unknown) =>
        typeof message === "string" &&
        message.trim().length > 0 &&
        RESULTS.every((result) => !result.test(message)),
      "the initiating turn acknowledges work without claiming results",
    ),
  );
  const taskIds = [
    ...new Set(
      started.events.flatMap((event) =>
        event.type === "subagent.completed" &&
        event.data.subagentName === "agent" &&
        event.data.backgroundTask !== undefined
          ? [event.data.backgroundTask.taskId]
          : [],
      ),
    ),
  ];
  await t.require(
    taskIds,
    satisfies(
      (ids: readonly string[]) => ids.length >= MIN_BACKGROUND_TASKS,
      "multiple independent background tasks exercise partial wakes",
    ),
  );
  return {
    session: t,
    sessionId: started.sessionId,
    taskIds,
    observed: new Set(),
    childSessionIds: new Set(childSessions(started)),
    wakes: [],
  };
}

export async function waitForPartialCompletion(
  t: EveEvalContext,
  run: ReportingRun,
): Promise<void> {
  for (let attempt = 0; attempt < 8 && run.observed.size === 0; attempt += 1) {
    await readTurn(t, run, nextTurn(t, run));
  }
  await t.require(
    run.observed.size,
    satisfies(
      (count: number) => count > 0 && count < run.taskIds.length,
      "an intermediate completion leaves sibling tasks pending",
    ),
  );
}

export async function sendQuestion(t: EveEvalContext, run: ReportingRun): Promise<EveEvalTurn> {
  let live = await run.session.start(QUESTION);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const turn = await readTurn(t, run, live);
    if (receivedQuestion(turn)) return turn;
    live = nextTurn(t, run);
  }
  throw new Error("No user turn followed the intermediate wake.");
}

export async function waitForReport(
  t: EveEvalContext,
  run: ReportingRun,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 8 && run.observed.size < run.taskIds.length; attempt += 1) {
    await readTurn(t, run, nextTurn(t, run));
  }
  await t.require(
    run.observed.size,
    satisfies((count: number) => count === run.taskIds.length, "all task wakes observed"),
  );
  return run.wakes
    .filter((wake) => wake.completed > 0 && wake.settled && !receivedQuestion(wake.turn))
    .at(-1)?.turn.message;
}

export function completeReport() {
  return satisfies(
    (message: unknown) =>
      typeof message === "string" && RESULTS.every((result) => result.test(message)),
    "settled tasks produce a complete user-facing report",
  );
}

export function requireStreamIndex(session: EveEvalSession | EveEvalContext): number {
  if (session.state === undefined) throw new Error("Task reporting session has no stream index.");
  return session.state.streamIndex;
}

function nextTurn(t: EveEvalContext, run: ReportingRun): EveEvalLiveTurn {
  return t.target.watchTurn(run.sessionId, { startIndex: requireStreamIndex(run.session) });
}

async function readTurn(
  t: EveEvalContext,
  run: ReportingRun,
  live: EveEvalLiveTurn,
): Promise<EveEvalTurn> {
  const turn = await live.result();
  turn.expectOk();
  turn.noFailedActions();
  const completed = turn.events
    .flatMap((event) => {
      if (event.type !== "message.received") return [];
      return [...event.data.message.matchAll(COMPLETION)].map((match) => match[1] as string);
    })
    .filter((taskId) => run.taskIds.includes(taskId));
  for (const taskId of completed) run.observed.add(taskId);
  for (const sessionId of childSessions(turn)) run.childSessionIds.add(sessionId);
  run.session = live.session;
  run.wakes.push({
    turn,
    completed: completed.length,
    settled: run.observed.size === run.taskIds.length,
  });
  t.log(
    `wake ${run.wakes.length}: completed=${run.observed.size}/${run.taskIds.length} message=${JSON.stringify(turn.message)}`,
  );
  return turn;
}

function childSessions(turn: EveEvalTurn): string[] {
  return turn.events.flatMap((event) =>
    event.type === "subagent.called" ? [event.data.childSessionId] : [],
  );
}

function receivedQuestion(turn: EveEvalTurn): boolean {
  return turn.events.some(
    (event) => event.type === "message.received" && event.data.message.includes(QUESTION),
  );
}

function hasPostReceiptAcknowledgement(turn: EveEvalTurn): boolean {
  const receiptIndexes = turn.events.flatMap((event, index) =>
    event.type === "subagent.completed" &&
    event.data.subagentName === "agent" &&
    event.data.backgroundTask !== undefined
      ? [index]
      : [],
  );
  const lastReceiptIndex = Math.max(...receiptIndexes);
  return (
    receiptIndexes.length >= MIN_BACKGROUND_TASKS &&
    turn.events.some(
      (event, index) =>
        index > lastReceiptIndex &&
        event.type === "message.completed" &&
        event.data.finishReason !== "tool-calls" &&
        event.data.message !== null &&
        event.data.message.trim().length > 0,
    )
  );
}
