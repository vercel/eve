import { e2eModel } from "@eve-e2e/config";
import type { EveEvalContext, EveEvalSession, EveEvalTurn, InputRequest } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

export const TASK_COUNT = 3;
export const QUESTION =
  "Alice is packing seven boxes with eight jars in each. How many jars is that? Reply with just the number.";

const CHECKS = ["first", "second", "third"] as const;
type Check = (typeof CHECKS)[number];
const RESULTS = { first: "oranges", second: "pears", third: "apples" } as const;
const COMPLETION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

interface Child {
  readonly check: Check;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface ReportingRun {
  readonly sessionId: string;
  readonly taskIds: readonly string[];
  readonly children: readonly Child[];
  readonly requests: ReadonlyMap<Check, InputRequest>;
  readonly completedChildren: Map<Check, EveEvalTurn>;
  readonly parentTurns: EveEvalTurn[];
  readonly modelId: string;
  session: EveEvalSession | EveEvalContext;
}

export async function startWarehouseLookups(t: EveEvalContext): Promise<ReportingRun> {
  const modelId = e2eModel();
  if (typeof modelId !== "string") throw new Error("Warehouse reporting requires a real CI model.");
  const started =
    await t.send(`Alice is preparing Bob's warehouse inventory handoff. Please start three independent background checks using the built-in agent tool, one call per check, before replying. Delegate instead of running the lookups yourself, passing each quoted request verbatim as the child's message. Each lookup needs Alice's approval. Acknowledge the accepted work, then give Bob one short report listing each inventory item once when all results arrive.

1. "For check=first, call probe with check=first and report its result value."
2. "For check=second, call probe with check=second and report its result value."
3. "For check=third, call warehouse_lookup with check=third. This tool waits for the warehouse specialist. Report its result value, not a launch acknowledgement."`);
  started.expectOk();
  started.calledSubagent("agent", { count: TASK_COUNT });
  started.notCalledTool("probe");
  started.notCalledTool("warehouse_lookup");
  assertModel(started, modelId);
  await t.require(
    started,
    satisfies(hasPostReceiptAcknowledgement, "acknowledgement follows all three task receipts"),
  );
  await t.require(
    started.message,
    satisfies(
      (message) =>
        typeof message === "string" &&
        message.trim().length > 0 &&
        Object.values(RESULTS).every((result) => !message.toLowerCase().includes(result)),
      "the initiating turn acknowledges work without claiming inventory results",
    ),
  );

  const receipts = started.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [{ callId: event.data.callId, taskId: event.data.backgroundTask.taskId }]
      : [],
  );
  const actions = started.events.flatMap((event) =>
    event.type === "actions.requested" ? event.data.actions : [],
  );
  const calls = started.events.flatMap((event) =>
    event.type === "subagent.called" ? [event.data] : [],
  );
  const children = calls.map((call): Child => {
    const message = actions.find((action) => action.callId === call.callId)?.input.message;
    const checks = CHECKS.filter(
      (check) => typeof message === "string" && message.includes(`check=${check}`),
    );
    const receipt = receipts.find((entry) => entry.callId === call.callId);
    if (checks.length !== 1 || receipt === undefined)
      throw new Error("Each warehouse child needs one check and a matching task receipt.");
    return { check: checks[0]!, sessionId: call.childSessionId, taskId: receipt.taskId };
  });
  const taskIds = receipts.map((receipt) => receipt.taskId);
  await t.require(
    {
      receipts: taskIds.length,
      tasks: new Set(taskIds).size,
      children: children.length,
      sessions: new Set(children.map((child) => child.sessionId)).size,
      checks: children.map((child) => child.check).sort(),
      mappedTasks: children.map((child) => child.taskId).sort(),
      creatingTurns: new Set(calls.map((call) => call.turnId)).size,
    },
    equals({
      receipts: TASK_COUNT,
      tasks: TASK_COUNT,
      children: TASK_COUNT,
      sessions: TASK_COUNT,
      checks: [...CHECKS].sort(),
      mappedTasks: [...taskIds].sort(),
      creatingTurns: 1,
    }),
  );

  const requests = new Map<Check, InputRequest>();
  const run: ReportingRun = {
    session: t,
    sessionId: started.sessionId,
    taskIds,
    children,
    requests,
    modelId,
    completedChildren: new Map(),
    parentTurns: [],
  };
  collectRequests(started);
  for (let attempt = 0; requests.size < TASK_COUNT && attempt < 8; attempt += 1) {
    collectRequests(await nextParentTurn(t, run));
  }
  await t.require(
    {
      checks: [...requests.keys()].sort(),
      ids: new Set([...requests.values()].map((request) => request.requestId)).size,
    },
    equals({ checks: [...CHECKS].sort(), ids: TASK_COUNT }),
  );
  // Setup includes prompt/approval wakes; completion admission is measured from this cursor onward.
  run.parentTurns.length = 0;
  return run;

  function collectRequests(turn: EveEvalTurn) {
    for (const request of turn.inputRequests) {
      if (request.action.toolName !== "probe")
        throw new Error("Unexpected warehouse approval tool.");
      const check = CHECKS.find((candidate) => candidate === request.action.input.check);
      if (
        check === undefined ||
        (requests.has(check) && requests.get(check)!.requestId !== request.requestId)
      ) {
        throw new Error("Each warehouse must have exactly one approval request.");
      }
      requests.set(check, request);
    }
  }
}

/** Establish partial completion on the child stream, without waiting for a withheld parent wake. */
export async function waitForPartialCompletion(
  t: EveEvalContext,
  run: ReportingRun,
): Promise<void> {
  await releaseCheck(t, run, "first");
  await t.require([...run.completedChildren.keys()], equals(["first"]));
}

export async function sendQuestion(t: EveEvalContext, run: ReportingRun): Promise<EveEvalTurn> {
  await post(t, run, "", { message: QUESTION, turnPolicy: "queue" });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const turn = await nextParentTurn(t, run);
    await t.require(completedTaskIds(turn), equals([]));
    if (
      turn.events.some(
        (event) => event.type === "message.received" && event.data.message === QUESTION,
      )
    ) {
      await t.require(turn.message?.trim(), equals("56"));
      turn.usedNoTools();
      await t.require(modelSteps(run.parentTurns), equals(1));
      return turn;
    }
    turn.notEvent("step.started");
  }
  throw new Error("No independent user answer while the remaining warehouses were gated.");
}

export async function compactWhilePending(t: EveEvalContext, run: ReportingRun): Promise<void> {
  await post(t, run, "/compact", {});
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const turn = await nextParentTurn(t, run);
    await t.require(completedTaskIds(turn), equals([]));
    turn.notEvent("step.started");
    if (turn.events.some((event) => event.type === "compaction.requested")) {
      turn.event("compaction.requested", { count: 1 });
      // A declined summary preserves history; either path must retain the held cohort.
      turn.event("compaction.completed", { count: 1 }).soft().label("successful checkpoint");
      await t.require(modelSteps(run.parentTurns), equals(0));
      return;
    }
  }
  throw new Error("No compaction boundary while the remaining warehouses were gated.");
}

export async function waitForReport(t: EveEvalContext, run: ReportingRun): Promise<EveEvalTurn> {
  await releaseCheck(t, run, "second");
  await releaseCheck(t, run, "third");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const turn = await nextParentTurn(t, run);
    const taskIds = completedTaskIds(turn);
    if (taskIds.length > 0) {
      await t.require(taskIds.sort(), equals([...run.taskIds].sort()));
      await t.require(
        run.parentTurns.flatMap(completedTaskIds).sort(),
        equals([...run.taskIds].sort()),
      );
      turn.usedNoTools();
      turn.event("step.started", { count: 1, data: { modelId: run.modelId } });
      turn.event("message.completed", {
        count: 1,
        data: (data) => data.finishReason !== "tool-calls" && data.message !== null,
      });
      turn.notEvent("message.completed", { data: (data) => data.message === null });
      await t.require(turn.message, completeReport());
      t.calledSubagent("agent", { count: TASK_COUNT });
      t.calledSubagent("warehouse-worker", { count: 1 });
      t.calledTool("probe", { count: TASK_COUNT });
      for (const check of CHECKS) {
        t.calledTool("probe", {
          count: 1,
          input: { check },
          output: { result: RESULTS[check] },
          status: "completed",
        });
      }
      return turn;
    }
    turn.notEvent("step.started");
  }
  throw new Error("No single report containing every original warehouse task.");
}

export function completeReport() {
  return satisfies(
    (message) =>
      typeof message === "string" &&
      JSON.stringify(
        message
          .toLowerCase()
          .match(/\b(?:oranges|pears|apples)\b/gu)
          ?.sort(),
      ) === JSON.stringify(Object.values(RESULTS).sort()),
    "one report contains each inventory item exactly once",
  );
}

export function modelSteps(turns: readonly EveEvalTurn[]): number {
  return turns.flatMap((turn) => turn.events).filter((event) => event.type === "step.started")
    .length;
}

export function completedAt(turn: EveEvalTurn): number {
  const event = turn.events.find((entry) => entry.type === "turn.completed");
  if (event === undefined) throw new Error("Missing child completion event.");
  return Date.parse(event.meta.at);
}

export function requireStreamIndex(session: EveEvalSession | EveEvalContext): number {
  if (session.state === undefined) throw new Error("Task reporting session has no stream index.");
  return session.state.streamIndex;
}

async function releaseCheck(t: EveEvalContext, run: ReportingRun, check: Check): Promise<void> {
  const request = run.requests.get(check);
  const child = run.children.find((entry) => entry.check === check);
  if (request === undefined || child === undefined || run.completedChildren.has(check)) {
    throw new Error(`No unreleased warehouse child for ${check}.`);
  }
  await post(t, run, "", {
    inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
  });
  const turns = await readCompletedChild(t, child.sessionId, check, run.modelId);
  run.completedChildren.set(check, turns.at(-1)!);
  if (check === "third") {
    const nested = turns
      .flatMap((turn) => turn.events)
      .flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "warehouse-worker"
          ? [event.data]
          : [],
      );
    await t.require(nested.length, equals(1));
    await t.require(
      run.children.some((entry) => entry.sessionId === nested[0]!.childSessionId),
      equals(false),
    );
    const leaf = await readCompletedChild(t, nested[0]!.childSessionId, check, run.modelId);
    await t.require(
      leaf
        .flatMap((turn) => turn.events)
        .flatMap((event) => (event.type === "actions.requested" ? event.data.actions : []))
        .filter((action) => action.kind === "tool-call" && action.toolName === "probe")
        .map((action) => action.input.check),
      equals([check]),
    );
    await t.require(completedAt(leaf.at(-1)!) <= completedAt(turns.at(-1)!), equals(true));
  }
}

async function readCompletedChild(
  t: EveEvalContext,
  sessionId: string,
  check: Check,
  modelId: string,
): Promise<EveEvalTurn[]> {
  const turns: EveEvalTurn[] = [];
  let startIndex = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const live = t.target.watchTurn(sessionId, { startIndex });
    const turn = (await live.result()).expectOk();
    assertModel(turn, modelId);
    turns.push(turn);
    startIndex = requireStreamIndex(live.session);
    if (
      turn.events.some((event) => event.type === "turn.completed") &&
      turn.message?.toLowerCase().includes(RESULTS[check])
    )
      return turns;
  }
  throw new Error(`Warehouse child ${check} did not complete with its inventory item.`);
}

async function nextParentTurn(t: EveEvalContext, run: ReportingRun): Promise<EveEvalTurn> {
  const live = t.target.watchTurn(run.sessionId, { startIndex: requireStreamIndex(run.session) });
  const turn = (await live.result()).expectOk();
  turn.noFailedActions();
  assertModel(turn, run.modelId);
  run.session = live.session;
  run.parentTurns.push(turn);
  return turn;
}

function assertModel(turn: EveEvalTurn, modelId: string) {
  turn.eventsSatisfy("every model step uses the real CI model", (events) =>
    events.every((event) => event.type !== "step.started" || event.data.modelId === modelId),
  );
}

function completedTaskIds(turn: EveEvalTurn): string[] {
  return turn.events.flatMap((event) =>
    event.type === "message.received"
      ? [...event.data.message.matchAll(COMPLETION)].map((match) => match[1]!)
      : [],
  );
}

async function post(t: EveEvalContext, run: ReportingRun, suffix: "" | "/compact", body: unknown) {
  const response = await t.target.fetch(
    `/eve/v1/session/${encodeURIComponent(run.sessionId)}${suffix}`,
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

function hasPostReceiptAcknowledgement(turn: EveEvalTurn): boolean {
  const receiptIndexes = turn.events.flatMap((event, index) =>
    event.type === "subagent.completed" &&
    event.data.subagentName === "agent" &&
    event.data.backgroundTask !== undefined
      ? [index]
      : [],
  );
  return (
    receiptIndexes.length === TASK_COUNT &&
    turn.events.some(
      (event, index) =>
        index > Math.max(...receiptIndexes) &&
        event.type === "message.completed" &&
        event.data.finishReason !== "tool-calls" &&
        event.data.message !== null &&
        event.data.message.trim().length > 0,
    )
  );
}
