import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import {
  requestWorkflowTurnCancellation,
  workflowToolRunWorkflowReference,
} from "#execution/workflow-runtime.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import {
  resumableAgentWorkflow,
  resumableNotesWorkflow,
  resumableOwnerProbeWorkflow,
  resumableQueueWorkflow,
} from "#internal/testing/resumable-workflow-fixtures.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { readWorkflowFunctionId } from "#internal/workflow/reference.js";
import { cancelRun, getRun, getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { cancelTasksStep } from "#tasks/cancel.js";
import { MAX_RETAINED_IDLE_TASKS } from "#tasks/owner-calls.js";
import type { TaskRecord } from "#tasks/record.js";
import { AGENT_CALL_CANCELLED_MESSAGE, TASK_ENDED_BEFORE_READ_MESSAGE } from "#tasks/render.js";
import { encodeTaskCreator, readPendingTaskResults } from "#tasks/results.js";
import { applyWorkflowSend, retireIdleTaskChildren } from "#tasks/send.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { findTask, markTaskDelivered, MAX_UNREAD_SENDS, MAX_WORKING_TASKS } from "#tasks/table.js";
import { applyWorkflowGenerationStep, startWorkflowTask } from "#tasks/workflow-task.js";

// The owner of resumable workflow tasks, run in memory against real workflow
// tool runs in the local Workflow world. A probe workflow stands in for the
// owner session's inbox; each test feeds the run's messages to the owner's
// own steps, as the session body does, and sends through the owner's real
// transport. Only a delivery failure is injected, at the run's command hook.

const injected = vi.hoisted(() => ({
  /** Command hooks whose next delivery reaches the run and then fails, as a timeout would. */
  ambiguous: new Set<string>(),
  /** Command hooks whose next delivery fails before it reaches the run. */
  lost: new Set<string>(),
}));

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#internal/workflow/runtime.js")>();
  return {
    ...actual,
    resumeHook: vi.fn(async (token: string, payload: unknown) => {
      if (injected.lost.delete(token)) throw new Error("connect ECONNREFUSED");
      const hook = await actual.resumeHook(token, payload as never);
      if (injected.ambiguous.delete(token)) throw new Error("socket hang up");
      return hook;
    }),
  };
});
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#tasks/timer-steps.js", async (importOriginal) => ({
  ...(await importOriginal()),
  armChildHardStop: vi.fn(),
}));

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-alice",
  principalType: "user",
};
const BOB: SessionAuthContext = { ...ALICE, principalId: "U-bob" };

type Recorded = WorkflowToolRunMessage;

function recorded(token: string): readonly Recorded[] {
  const store = (globalThis as { __resumableRuns?: Record<string, Recorded[]> }).__resumableRuns;
  return store?.[token] ?? [];
}

async function until<T>(read: () => T | undefined, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the run");
}

let sequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
  injected.ambiguous.clear();
  injected.lost.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** An owner session held in memory, with one resumable workflow task on a real run. */
async function startOwnedTask(input: {
  readonly name: string;
  readonly execute: (...args: never[]) => unknown;
  readonly input: Record<string, unknown>;
  readonly creator?: SessionAuthContext | null;
}) {
  sequence += 1;
  const sessionId = `owner-${String(sequence)}-${String(Date.now())}`;
  const inbox = `resumable-owner:${sessionId}`;
  const probe = await start(resumableOwnerProbeWorkflow, [{ token: inbox }]);
  await waitForHook(probe, { token: inbox });
  const workflowId = readWorkflowFunctionId(input.execute)!;
  const owner = {
    applied: 0,
    events: [] as UnstampedMessageStreamEvent[],
    inbox,
    results: [] as RuntimeToolResultActionResult[],
    runId: "",
    state: createTestSessionState({ sessionId }) as DurableSessionState,
    taskId: "",
    token: "",
  };
  const session = () => readDurableSession(owner.state);
  const commit = (next: ReturnType<typeof session>) => {
    owner.state = replaceDurableSessionSnapshot({ session: next, state: owner.state });
  };
  const started = await startWorkflowTask({
    creator: { auth: input.creator ?? null },
    now: new Date().toISOString(),
    request: {
      callId: "call-start",
      input: input.input as never,
      kind: "workflow-task",
      resumable: true,
      toolName: input.name,
      workflowId,
    },
    session: session(),
    startRun: async (record) => {
      const hookToken = `eve:workflow-task:${sessionId}:${record.id}`;
      const runInput: WorkflowToolRunInput = {
        callId: "call-start",
        hookToken,
        input: input.input as never,
        owner: { inbox },
        resumable: true,
        session: {
          auth: { current: input.creator ?? null, initiator: input.creator ?? null },
          id: sessionId,
          turn: { id: "turn-1", sequence: 1 },
        },
        stepIndex: 0,
        taskId: record.id,
        toolName: input.name,
        workflowId,
      };
      const run = await start(workflowToolRunWorkflowReference, [runInput]);
      await waitForHook(run, { token: hookToken });
      return { hookToken, runId: run.runId };
    },
    turnId: "turn-1",
  });
  commit(started.session);
  const record = getTaskTable(session()).records[0]!;
  owner.taskId = record.id;
  owner.token = record.child?.kind === "workflow" ? record.child.commandToken : "";
  owner.runId = record.child?.kind === "workflow" ? record.child.runId : "";

  /** A model call to the task's tool with its `taskId`. */
  const send = async (
    callId: string,
    request: string,
    options: { readonly caller?: SessionAuthContext | null; readonly toolName?: string } = {},
  ) => {
    const sent = await applyWorkflowSend({
      call: { callId, stepIndex: 0, turn: { id: `turn-${callId}`, sequence: 2 } },
      caller: options.caller === undefined ? (input.creator ?? null) : options.caller,
      ctx: undefined,
      now: new Date().toISOString(),
      request: {
        callId,
        input: { request },
        kind: "workflow-task",
        resumable: true,
        taskId: owner.taskId,
        toolName: options.toolName ?? input.name,
        workflowId,
      },
      session: session(),
    });
    commit(sent.session);
    owner.events.push(...sent.events);
    return sent.results[0]!;
  };

  /** Applies the run's messages until `count` have arrived, as the session body would. */
  const pump = async (count: number, onRequest?: (message: Recorded) => Promise<void>) => {
    await until(() => (recorded(inbox).length >= count ? true : undefined));
    for (const message of recorded(inbox).slice(owner.applied, count)) {
      owner.applied += 1;
      if (message.kind === "request") {
        await onRequest?.(message);
        continue;
      }
      if (message.kind !== "started" && message.kind !== "reply" && message.kind !== "ended") {
        continue;
      }
      const update = await applyWorkflowGenerationStep({
        message,
        serializedContext: {},
        sessionState: owner.state,
      });
      owner.state = update.sessionState;
      owner.events.push(...update.events);
      owner.results.push(...update.results);
      for (const reply of update.replies) {
        await resumeHook(reply.replyTo, {
          kind: "runtime-action-result",
          results: [reply.result],
        } as never);
      }
    }
  };

  const task = () => findTask(getTaskTable(session()), owner.taskId);
  const seed = (records: readonly TaskRecord[]) => {
    const current = session();
    commit({
      ...current,
      state: {
        ...current.state,
        ...taskTableState([...getTaskTable(current).records, ...records]),
      },
    });
  };
  const settled = () =>
    owner.events.flatMap((event) =>
      event.type === "task.settled" && event.data.taskId === owner.taskId ? [event.data] : [],
    );
  return { commit, owner, pump, seed, send, session, settled, task };
}

async function untilRunStatus(runId: string, status: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await getRun(runId).status) === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${status}`);
}

function lastKinds(inbox: string): string[] {
  return recorded(inbox).map((message) =>
    message.kind === "started"
      ? `started g${String(message.from.generation)} send ${String(message.send)}`
      : message.kind,
  );
}

describe("sends to a working resumable workflow task", () => {
  it("refuses what it cannot take, queues the rest, and fails the sends the body never read", async () => {
    const gate = `resumable-owner:gate:${String(Date.now())}`;
    const { owner, pump, send, settled, task } = await startOwnedTask({
      creator: ALICE,
      execute: resumableQueueWorkflow,
      input: { gate, reads: 1, request: "v1" },
      name: "release_notes",
    });

    expect(await send("call-bob", "mine now", { caller: BOB })).toMatchObject({
      output: { code: "TASK_OTHER_PRINCIPAL" },
    });
    // Another principal cannot learn the task's tool, even by naming the wrong one.
    expect(await send("call-bob-2", "x", { caller: BOB, toolName: "deploy" })).toMatchObject({
      output: { code: "TASK_OTHER_PRINCIPAL" },
    });
    expect(await send("call-wrong-tool", "x", { toolName: "deploy" })).toMatchObject({
      output: { code: "TASK_MISMATCH" },
    });

    for (let seq = 1; seq <= MAX_UNREAD_SENDS; seq++) {
      expect(await send(`call-${String(seq)}`, `r${String(seq)}`)).toMatchObject({
        output: { status: "working", taskId: owner.taskId },
      });
    }
    expect(await send("call-over", "one too many")).toMatchObject({
      isError: true,
      output: { code: "TASK_BUSY" },
    });
    expect(task()?.sends).toHaveLength(MAX_UNREAD_SENDS);

    await resumeHook(gate, undefined as never);
    // g1 read send 1; the owner starts g2 for send 2 itself; the run confirms it,
    // answers it, and returns without reading the rest.
    await pump(4);
    expect(lastKinds(owner.inbox)).toEqual(["reply", "started g2 send 2", "reply", "ended"]);
    expect(recorded(owner.inbox)[3]).toMatchObject({
      unread: Array.from({ length: MAX_UNREAD_SENDS - 2 }, (_, index) => index + 3),
    });
    const results = settled();
    expect(results.slice(0, 2)).toEqual([
      expect.objectContaining({ callId: "call-start", output: "v1+r1", status: "completed" }),
      expect.objectContaining({ callId: "call-2", output: "next r2", status: "completed" }),
    ]);
    expect(results.slice(2)).toHaveLength(MAX_UNREAD_SENDS - 2);
    for (const [index, result] of results.slice(2).entries()) {
      expect(result).toMatchObject({
        callId: `call-${String(index + 3)}`,
        error: { code: "EXECUTION_FAILED", message: TASK_ENDED_BEFORE_READ_MESSAGE },
        status: "failed",
      });
    }
    expect(task()).toMatchObject({ ended: true });
    await untilRunStatus(owner.runId, "completed");
  }, 60_000);
});

describe("sends to an idle resumable workflow task", () => {
  it("counts a send that restarts the task against the working-task cap", async () => {
    const { owner, pump, seed, send, task } = await startOwnedTask({
      execute: resumableNotesWorkflow,
      input: { request: "0.67" },
      name: "release_notes",
    });
    await pump(1);
    expect(task()).toMatchObject({ generation: 1, status: "completed" });
    const busy = Array.from({ length: MAX_WORKING_TASKS }, (_, index) =>
      createTaskRecord({
        callId: `call-busy-${String(index)}`,
        id: `lookup-${String(index).padStart(6, "0")}`,
        kind: "workflow",
        mode: "detached",
        name: "lookup",
      }),
    );
    seed(busy);

    expect(await send("call-1", "shorter")).toMatchObject({
      isError: true,
      output: { code: "TOO_MANY_TASKS" },
    });
    expect(recorded(owner.inbox)).toHaveLength(1);
    expect(task()).toMatchObject({ generation: 1, status: "completed" });
    await cancelRun(await getWorld(), owner.runId, { cancelReason: "test finished" });
  }, 60_000);

  it("ends an idle run with its session", async () => {
    const { owner, pump, send, settled, task } = await startOwnedTask({
      execute: resumableNotesWorkflow,
      input: { request: "0.67" },
      name: "release_notes",
    });
    await pump(1);
    expect(await send("call-1", "shorter")).toMatchObject({ output: { status: "working" } });
    await pump(3);
    expect(settled().map((result) => result.callId)).toEqual(["call-start", "call-1"]);

    await terminateChildSessionsStep({ sessionState: owner.state });

    await pump(4);
    expect(recorded(owner.inbox)[3]).toMatchObject({ kind: "ended", unread: [] });
    // Its last result still waits for the model, so the ended record stays until then.
    expect(task()).toMatchObject({ ended: true, generation: 2 });
    await untilRunStatus(owner.runId, "completed");
  }, 60_000);

  it("ends an idle run the idle cap retires", async () => {
    const { commit, owner, pump, seed, session, task } = await startOwnedTask({
      execute: resumableNotesWorkflow,
      input: { request: "0.67" },
      name: "release_notes",
    });
    await pump(1);
    commit(setTaskTable(session(), markTaskDelivered(getTaskTable(session()), owner.taskId, 1)));
    const later = Date.now() + 60_000;
    seed(
      Array.from({ length: MAX_RETAINED_IDLE_TASKS }, (_, index) =>
        createTaskRecord({
          callId: `call-idle-${String(index)}`,
          child: {
            continuationToken: `t${String(index)}`,
            kind: "local",
            sessionId: `s${String(index)}`,
          },
          creator: encodeTaskCreator({ auth: null }),
          delivered: true,
          id: `research-${String(index).padStart(6, "0")}`,
          startedAt: new Date(later + index * 1000).toISOString(),
          status: "completed",
        }),
      ),
    );

    const retired = await retireIdleTaskChildren({
      caller: null,
      ctx: undefined,
      now: new Date().toISOString(),
      session: session(),
    });
    commit(retired.session);

    expect(task()).toBeUndefined();
    await pump(2);
    expect(recorded(owner.inbox)[1]).toMatchObject({ kind: "ended", unread: [] });
    await untilRunStatus(owner.runId, "completed");
  }, 60_000);
});

describe("a send whose delivery fails", () => {
  it("returns TASK_UNREACHABLE, spends its number, and a retry reaches the run", async () => {
    const { owner, pump, send, settled, task } = await startOwnedTask({
      execute: resumableNotesWorkflow,
      input: { request: "0.67" },
      name: "release_notes",
    });
    await pump(1);
    injected.lost.add(owner.token);

    expect(await send("call-1", "shorter")).toMatchObject({
      isError: true,
      output: { code: "TASK_UNREACHABLE", message: expect.stringContaining("temporarily") },
    });
    expect(task()).toMatchObject({ generation: 1, lastSeq: 1, status: "completed" });

    expect(await send("call-2", "longer")).toMatchObject({ output: { status: "working" } });
    await pump(3);
    expect(lastKinds(owner.inbox)).toEqual(["reply", "started g2 send 2", "reply"]);
    expect(settled()[1]).toMatchObject({ callId: "call-2", status: "completed" });
    await cancelRun(await getWorld(), owner.runId, { cancelReason: "test finished" });
  }, 60_000);

  it("ends the task when its run is gone for good", async () => {
    const { owner, pump, send, task } = await startOwnedTask({
      execute: resumableNotesWorkflow,
      input: { request: "0.67" },
      name: "release_notes",
    });
    await pump(1);
    // The run dies without reporting, as a crashed deployment would leave it.
    await cancelRun(await getWorld(), owner.runId, { cancelReason: "crashed" });
    await untilRunStatus(owner.runId, "cancelled");

    expect(await send("call-1", "shorter")).toMatchObject({
      isError: true,
      output: {
        code: "TASK_UNREACHABLE",
        message: expect.stringContaining("its workflow run ended"),
      },
    });
    // The task ended; its first result is still on its way to the model.
    expect(task()).toMatchObject({ ended: true, generation: 1 });
    expect(task()?.child).toBeUndefined();
    expect(await send("call-2", "again")).toMatchObject({ output: { code: "UNKNOWN_TASK" } });
  }, 60_000);

  it.each(["before", "after"] as const)(
    "converges when the run took the input anyway (the run's start arrives %s the retry)",
    async (order) => {
      const { owner, pump, send, settled, task } = await startOwnedTask({
        execute: resumableNotesWorkflow,
        input: { request: "0.67" },
        name: "release_notes",
      });
      await pump(1);
      injected.ambiguous.add(owner.token);

      expect(await send("call-1", "shorter")).toMatchObject({
        output: { code: "TASK_UNREACHABLE" },
      });
      expect(task()).toMatchObject({ generation: 1, lastSeq: 1, status: "completed" });
      if (order === "before") {
        // The run started generation 2 for the send; the owner adopts it.
        await pump(2);
        expect(task()).toMatchObject({ callId: "call-1", generation: 2, status: "working" });
      }
      expect(await send("call-2", "longer")).toMatchObject({ output: { status: "working" } });
      await pump(5);

      expect(lastKinds(owner.inbox)).toEqual([
        "reply",
        "started g2 send 1",
        "reply",
        "started g3 send 2",
        "reply",
      ]);
      // Each generation settles once, for the send the run gave it.
      expect(settled().map((result) => [result.callId, result.output])).toEqual([
        ["call-start", "notes(0.67) @call-start"],
        ["call-1", "notes(0.67)>shorter @call-1"],
        ["call-2", "notes(0.67)>shorter>longer @call-2"],
      ]);
      expect(task()).toMatchObject({ generation: 3, status: "completed" });
      expect(task()?.sends).toBeUndefined();
      expect(task()?.undelivered).toBeUndefined();
      expect(readPendingTaskResults(owner.state.snapshot.session.state)).toHaveLength(3);
      await cancelRun(await getWorld(), owner.runId, { cancelReason: "test finished" });
    },
    60_000,
  );
});

describe("agent tasks a resumable generation owns", () => {
  const agentFor = (message: Extract<Recorded, { kind: "request" }>): TaskRecord => {
    if (message.request.kind !== "agent-invoke") throw new Error(message.request.kind);
    return createTaskRecord({
      callId: message.request.invocationId,
      child: { continuationToken: "agent-token", kind: "local", sessionId: "agent-session" },
      id: "researcher-7k2m9q",
      name: "researcher",
      turnId: "turn-1",
      workflowCaller: { replyTo: message.replyTo, runId: message.from.runId },
    });
  };

  it("cancels an agent the generation still owns when it replies", async () => {
    const gate = `resumable-owner:agent-gate:${String(Date.now())}`;
    const { owner, pump, seed, send, settled } = await startOwnedTask({
      execute: resumableAgentWorkflow,
      input: { gate, request: "Look into the Q3 numbers." },
      name: "analysis",
    });
    // The owner starts the agent the body asks for.
    await pump(1, async (message) => {
      if (message.kind === "request") seed([agentFor(message)]);
    });
    await resumeHook(gate, undefined as never);
    await pump(2);

    const agentEvents = owner.events.filter(
      (event) => event.type === "task.settled" && event.data.taskId === "researcher-7k2m9q",
    );
    expect(agentEvents).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
    ]);
    // The agent's cancellation precedes the generation's result.
    expect(owner.events.map((event) => event.type === "task.settled" && event.data.taskId)).toEqual(
      ["researcher-7k2m9q", owner.taskId],
    );
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "agent-session" });

    await send("call-1", "Summarize");
    await pump(5);
    expect(settled().map((result) => result.output)).toEqual([
      "replied first",
      `Summarize: agent ${AGENT_CALL_CANCELLED_MESSAGE}`,
    ]);
  }, 60_000);

  it("cancels the agent call whose signal aborted", async () => {
    const gate = `resumable-owner:signal-gate:${String(Date.now())}`;
    const { owner, pump, seed, session, settled } = await startOwnedTask({
      execute: resumableAgentWorkflow,
      input: { abort: true, gate, request: "Look into the Q3 numbers." },
      name: "analysis",
    });
    await pump(1, async (message) => {
      if (message.kind === "request") seed([agentFor(message)]);
    });
    await resumeHook(gate, undefined as never);
    // The body aborts the call: its request reaches the owner, which cancels
    // that call's task, as the session body routes it.
    await pump(2, async (message) => {
      if (message.kind !== "request" || message.request.kind !== "agent-cancel") return;
      const update = await cancelTasksStep({
        selector: {
          callId: message.request.invocationId,
          kind: "agent-call",
          runId: message.from.runId,
        },
        serializedContext: {},
        sessionState: owner.state,
      });
      owner.state = update.sessionState;
      owner.events.push(...update.events);
    });
    await pump(4);

    expect(findTask(getTaskTable(session()), "researcher-7k2m9q")).toMatchObject({
      status: "cancelled",
    });
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "agent-session" });
    expect(settled().map((result) => result.output)).toEqual([
      "agent: Alice no longer needs the research.",
    ]);
  }, 60_000);
});
