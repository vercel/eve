import { e2eModel } from "@eve-e2e/config";
import type { EveEvalContext, EveEvalSession, EveEvalTurn, InputRequest } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import {
  CHECKS,
  childActivations,
  checkForTask,
  eventsForSession,
  toolEvidence,
  type Check,
} from "./event-matching.js";

export const TASK_COUNT = 3;
export const QUESTION =
  "Alice is packing seven boxes with eight jars in each. How many jars is that? Reply with just the number.";

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
  readonly childTurns: EveEvalTurn[];
  readonly probeSessions: Map<Check, string>;
  readonly parentTurns: EveEvalTurn[];
  readonly modelId: string;
  session: EveEvalSession | EveEvalContext;
}

export async function startWarehouseLookups(t: EveEvalContext): Promise<ReportingRun> {
  const modelId = e2eModel();
  if (typeof modelId !== "string") throw new Error("Warehouse reporting requires a real CI model.");
  const started =
    await t.send(`Alice is preparing an inventory checklist for Bob's warehouse handoff. Please delegate these three entries to three separate background assistants using the built-in agent tool, so the checks can proceed independently. Include the entry's check reference in each assistant's assignment. Keep this small checklist in the conversation rather than creating a separate todo list.

1. check=first: Find the inventory item for the first entry using the inventory lookup tool (probe), and share the item it returns.
2. check=second: Find the inventory item for the second entry using the inventory lookup tool (probe), and share the item it returns.
3. check=third: Use warehouse_lookup to get the third entry from the warehouse specialist, and share the item the specialist returns.

Once all three assignments are accepted, let Alice know the checks are underway. When all three results are ready, reply directly from the returned items without further tool calls or task-list updates. Bob needs only three checklist entries, with each item listed once and no separate summary.`);
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
  const setupTurns = [started];
  let calls = childActivations(setupTurns, started.sessionId);
  const children: Child[] = [];
  const taskIds = receipts.map((receipt) => receipt.taskId);
  const requests = new Map<Check, InputRequest>();
  const run: ReportingRun = {
    session: t,
    sessionId: started.sessionId,
    taskIds,
    children,
    requests,
    modelId,
    completedChildren: new Map(),
    childTurns: [],
    probeSessions: new Map(),
    parentTurns: [],
  };
  collectRequests(started);
  // Task receipts precede child startup; called events can arrive after the parent parks.
  for (
    let attempt = 0;
    (calls.length < TASK_COUNT || requests.size < TASK_COUNT) && attempt < 8;
    attempt += 1
  ) {
    const turn = await nextParentTurn(t, run);
    setupTurns.push(turn);
    calls = childActivations(setupTurns, started.sessionId);
    collectRequests(turn);
  }
  children.push(
    ...calls.map((call): Child => {
      const assignments = actions.filter(
        (action) =>
          action.callId === call.callId &&
          action.kind === "tool-call" &&
          action.toolName === "agent",
      );
      const matchingReceipts = receipts.filter((entry) => entry.callId === call.callId);
      const receipt = matchingReceipts[0];
      if (
        call.sessionId !== started.sessionId ||
        call.name !== "agent" ||
        assignments.length !== 1 ||
        matchingReceipts.length !== 1 ||
        receipt === undefined
      )
        throw new Error("Each warehouse child needs one assignment and a matching task receipt.");
      return {
        check: checkForTask(receipt.taskId, [...requests.values()]),
        sessionId: call.childSessionId,
        taskId: receipt.taskId,
      };
    }),
  );
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
      const probeCalls = [...new Set(run.childTurns.map((child) => child.sessionId))].flatMap(
        (sessionId) => toolEvidence(run.childTurns, sessionId, "probe"),
      );
      await t.require(probeCalls.length, equals(TASK_COUNT));
      for (const check of CHECKS) {
        const sessionId = run.probeSessions.get(check);
        if (sessionId === undefined) throw new Error(`Missing probe session for ${check}.`);
        await t.require(
          toolEvidence(run.childTurns, sessionId, "probe"),
          equals([
            {
              callId: run.requests.get(check)!.action.callId,
              inputs: [{ check }],
              results: [{ output: { result: RESULTS[check] }, status: "completed" }],
            },
          ]),
        );
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
  run.childTurns.push(...turns);
  const nested = childActivations(turns, child.sessionId);
  if (check !== "third") {
    await t.require(nested, equals([]));
    run.probeSessions.set(check, child.sessionId);
    return;
  }
  await t.require(nested.length, equals(1));
  const delegate = nested[0]!;
  const lookup = toolEvidence(turns, child.sessionId, "warehouse_lookup");
  await t.require(lookup.length, equals(1));
  await t.require(
    {
      name: delegate.name,
      sessionId: delegate.sessionId,
      ownedCall: delegate.callId.startsWith(`${lookup[0]!.callId}:`),
      distinctSession:
        delegate.childSessionId !== run.sessionId &&
        !run.children.some((entry) => entry.sessionId === delegate.childSessionId),
    },
    equals({
      name: "warehouse-worker",
      sessionId: child.sessionId,
      ownedCall: true,
      distinctSession: true,
    }),
  );
  const leaf = await readCompletedChild(t, delegate.childSessionId, check, run.modelId);
  run.childTurns.push(...leaf);
  run.probeSessions.set(check, delegate.childSessionId);
  await t.require(
    eventsForSession(leaf, delegate.childSessionId).filter(
      (event) => event.type === "subagent.called",
    ),
    equals([]),
  );
  // ctx.agent completes through its owning workflow tool, not a subagent.completed event.
  await t.require(
    lookup,
    equals([
      {
        callId: lookup[0]!.callId,
        inputs: [{ check }],
        results: [{ status: "completed", output: leaf.at(-1)!.message }],
      },
    ]),
  );
  await t.require(completedAt(leaf.at(-1)!) <= completedAt(turns.at(-1)!), equals(true));
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
