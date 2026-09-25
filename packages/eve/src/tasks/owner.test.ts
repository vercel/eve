import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { startSubagent } from "#tasks/start.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import {
  createWorkflowRuntime,
  requestWorkflowSessionEnd,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { getSessionTokenUsage } from "#harness/turn-tag-state.js";
import { taskTable, createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionStateMap } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { cancelTasksStep } from "#tasks/cancel.js";
import { applyTaskReport, startAgentTasks, type AgentTaskCall } from "#tasks/owner.js";
import type { ChildTaskReport } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  getTaskTable,
  ownerInboxHookToken,
  readTaskCallbackAlias,
  TASK_CALLBACK_ALIAS_STATE_KEY,
} from "#tasks/state.js";
import { cancelTask, MAX_WORKING_TASKS, pruneTaskTable } from "#tasks/table.js";
import { evaluateTaskDeadlines } from "#tasks/table-deadlines.js";
import { MAX_RETAINED_IDLE_TASKS } from "#tasks/owner-calls.js";
import { armChildHardStop } from "#tasks/timer-steps.js";
import { renderSendReceipt, renderStartReceipt, renderTaskOtherPrincipal } from "#tasks/render.js";
import { encodeTaskCreator, readPendingTaskResults } from "#tasks/results.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/coordination-dispatch-shared.js", () => ({ prepareActionDispatch: vi.fn() }));
vi.mock("#tasks/start.js", async (importOriginal) => ({
  ...(await importOriginal()),
  startSubagent: vi.fn(),
}));
vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#tasks/timer-steps.js", async (importOriginal) => ({
  ...(await importOriginal()),
  armChildHardStop: vi.fn(),
}));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createWorkflowRuntime: vi.fn(),
  requestWorkflowSessionEnd: vi.fn(),
  requestWorkflowTurnCancellation: vi.fn(),
}));

const NOW = "2026-09-24T14:00:00.000Z";
const OWNER_INBOX = ownerInboxHookToken("parent");
const LOCAL_CHILD = {
  continuationToken: "child-token",
  kind: "local" as const,
  sessionId: "child-session",
};
const REMOTE_CHILD = {
  callbackBaseUrl: "https://parent.example",
  kind: "remote" as const,
  sessionId: "remote-child",
  url: "https://billing.example",
};
const CALLBACK_ALIAS = `eve:task-callback:${"ab".repeat(24)}`;
const ZERO_USAGE = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

const bundle = {
  compiledArtifactsSource: {},
  subagentRegistry: {
    subagentsByName: new Map([
      [
        "research",
        {
          definition: {
            description: "Research",
            kind: "subagent",
            name: "research",
            nodeId: "subagents/research",
          },
        },
      ],
      [
        "billing",
        {
          definition: {
            description: "Billing",
            kind: "remote",
            name: "billing",
            nodeId: "subagents/billing.ts",
          },
        },
      ],
    ]),
    subagentsByNodeId: new Map([
      ["subagents/research", { definition: { description: "Research", kind: "subagent" } }],
      ["subagents/billing.ts", { definition: { kind: "remote", name: "billing" } }],
    ]),
  },
  turnAgent: {},
};
const dispatchSession = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  const ctx = new ContextContainer();
  ctx.set(BundleKey, bundle as never);
  vi.mocked(deserializeContext).mockResolvedValue(ctx);
  vi.mocked(prepareActionDispatch).mockImplementation(
    async (input) =>
      ({
        auth: null,
        bundle,
        capabilities: undefined,
        channelMetadata: undefined,
        creator: { auth: null },
        fanoutSize: input.fanoutSize ?? 1,
        initiatorAuth: null,
        plan: input.plan({
          bundle: bundle as never,
          ctx: input.ctx,
          requests: input.batch.requests,
          session: runtimeSession(input.durableSession),
        }),
        sandboxSessionId: "parent",
        session: runtimeSession(input.durableSession),
      }) as never,
  );
  dispatchSession.mockResolvedValue({ status: "accepted" });
  vi.mocked(createWorkflowRuntime).mockReturnValue({ dispatchSession } as never);
});

describe("startAgentTasks", () => {
  it("commits a detached record for a fresh local start and returns its receipt", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });

    const update = await start([modelCall()]);

    const [record] = records(update.sessionState);
    // A local child announces itself when it reports task.started.
    expect(update).toMatchObject({
      events: [],
      replies: [],
      results: [
        expect.objectContaining({
          callId: "call-1",
          output: { status: "working", taskId: record?.id },
        }),
      ],
    });
    expect(record).toMatchObject({
      callId: "call-1",
      generation: 1,
      kind: "agent",
      mode: "detached",
      name: "research",
      nodeId: "subagents/research",
      status: "working",
      turnId: "turn-1",
    });
    expect(record?.id).toMatch(/^research-[0-9a-z]{6}$/u);
    expect(record?.child).toBeUndefined();
    expect(prepareActionDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batch: expect.objectContaining({
          event: expect.objectContaining({ stepIndex: 1, turnId: "turn-1" }),
        }),
      }),
    );
    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        batchEvent: { sequence: 3, turnId: "turn-1" },
        callbackBaseUrl: "https://parent.example",
        parentContinuationToken: OWNER_INBOX,
        target: expect.objectContaining({ kind: "local" }),
        taskId: record?.id,
      }),
    );
  });

  it("gives each call its target's authored timeout, or the 2-hour default", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });
    const graph = (timeout: number | false | undefined) => ({
      nodesByNodeId: new Map([["subagents/research", { agent: { config: { timeout } } }]]),
    });
    const deadline = async (timeout: number | false | undefined) => {
      Object.assign(bundle, { graph: graph(timeout) });
      try {
        return records((await start([modelCall()])).sessionState)[0]?.deadlineAt;
      } finally {
        Reflect.deleteProperty(bundle, "graph");
      }
    };

    await expect(deadline(undefined)).resolves.toBe("2026-09-24T16:00:00.000Z");
    await expect(deadline(60_000)).resolves.toBe("2026-09-24T14:01:00.000Z");
    await expect(deadline(false)).resolves.toBeUndefined();
  });

  it("gives a remote agent call the remote definition's timeout", async () => {
    vi.mocked(startSubagent).mockResolvedValue({
      kind: "started",
      remote: {
        callbackBaseUrl: REMOTE_CHILD.callbackBaseUrl,
        sessionId: REMOTE_CHILD.sessionId,
        url: REMOTE_CHILD.url,
      },
    } as never);
    const remote = bundle.subagentRegistry.subagentsByNodeId.get("subagents/billing.ts")!;
    Object.assign(remote.definition, { timeout: 5_000 });
    try {
      const update = await start([modelCall({ target: "billing" })], [], {
        [TASK_CALLBACK_ALIAS_STATE_KEY]: CALLBACK_ALIAS,
      });
      expect(records(update.sessionState)[0]?.deadlineAt).toBe("2026-09-24T14:00:05.000Z");
    } finally {
      Reflect.deleteProperty(remote.definition, "timeout");
    }
  });

  it("records the waiting turn from the pending batch after the live turn cleared", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });
    const cleared = setHarnessEmissionState(runtimeSession(readDurableSession(ownerState([]))), {
      sequence: 4,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "",
    });
    const parked = setPendingCoordinationBatch({
      event: { sequence: 3, stepIndex: 1, turnId: "turn-1" },
      responseMessages: [],
      session: cleared,
      tasks: [],
    });

    const update = await startAgentTasks({
      callbackBaseUrl: "https://parent.example",
      calls: [modelCall()],
      now: NOW,
      serializedContext: {},
      sessionState: createDurableSessionState({ session: parked }),
    });

    expect(records(update.sessionState)).toEqual([expect.objectContaining({ turnId: "turn-1" })]);
  });

  it.each([
    ["fresh start", undefined],
    ["continuation", "research-abc234"],
  ])("repeats no side effects for a replayed %s", async (_name, taskId) => {
    const existing = createTaskRecord();

    const update = await start([modelCall({ taskId })], [existing]);

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(startSubagent).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual([existing]);
  });

  it("adopts a remote child at once and announces it", async () => {
    vi.mocked(startSubagent).mockResolvedValue({
      kind: "started",
      remote: {
        callbackBaseUrl: "https://parent.example",
        credentialResolver: "subagents/billing.ts",
        sessionId: "remote-child",
        url: "https://billing.example",
      },
    });

    const update = await start([modelCall({ target: "billing" })], [], {
      [TASK_CALLBACK_ALIAS_STATE_KEY]: CALLBACK_ALIAS,
    });

    const [record] = records(update.sessionState);
    expect(record?.child).toEqual({
      callbackBaseUrl: "https://parent.example",
      credentialResolver: "subagents/billing.ts",
      kind: "remote",
      sessionId: "remote-child",
      url: "https://billing.example",
    });
    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          child: {
            remote: { resolverId: "subagents/billing.ts", url: "https://billing.example" },
            sessionId: "remote-child",
            streamPath: "/eve/v1/session/parent/subagents/call-1/remote-child/stream",
          },
          generation: 1,
          kind: "agent",
          mode: "detached",
          name: "billing",
          resumable: true,
          taskId: record?.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
    expect(update.results).toEqual([
      expect.objectContaining({ modelOutput: renderStartReceipt(record!, "billing") }),
    ]);
    // Remote children call back on the owner's unguessable alias, never its stable inbox.
    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentContinuationToken: sessionInboxHookToken(CALLBACK_ALIAS),
        taskId: record?.id,
      }),
    );
    expect(update.serializedContext).toEqual({});
  });

  it("mints a callback alias and starts nothing when a remote call finds none", async () => {
    const update = await start([modelCall({ target: "billing" }), modelCall({ callId: "call-2" })]);

    // The owner claims the alias and starts the whole batch again.
    expect(update.callbackAliasMinted).toBe(true);
    expect(readTaskCallbackAlias(readDurableSession(update.sessionState).state)).toMatch(
      /^eve:task-callback:[0-9a-f]{48}$/u,
    );
    expect(records(update.sessionState)).toEqual([]);
    expect(update.results).toEqual([]);
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it("starts local calls without minting a callback alias", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });

    const update = await start([modelCall()]);

    expect(update.callbackAliasMinted).toBeUndefined();
    expect(readTaskCallbackAlias(readDurableSession(update.sessionState).state)).toBeUndefined();
    expect(startSubagent).toHaveBeenCalledOnce();
  });

  it("returns the start error and keeps no record of an agent that never started", async () => {
    const output = { code: "START_FAILED", message: "The queue is unavailable." };
    vi.mocked(startSubagent).mockResolvedValue({
      kind: "error",
      result: {
        callId: "call-1",
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output,
        subagentName: "research",
      },
    });

    const update = await start([modelCall()]);

    expect(update.results).toEqual([
      { callId: "call-1", isError: true, kind: "tool-result", output, toolName: "research" },
    ]);
    const taskId = vi.mocked(startSubagent).mock.calls[0]![0].taskId;
    // The child never started: the task starts with no child, fails, and ends.
    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          generation: 1,
          kind: "agent",
          mode: "detached",
          name: "research",
          resumable: true,
          taskId,
          turnId: "turn-1",
        },
        type: "task.started",
      },
      {
        data: { callId: "call-1", error: output, generation: 1, status: "failed", taskId },
        type: "task.settled",
      },
      { data: { taskId }, type: "task.ended" },
    ]);
    // The ended, delivered record has no child to continue, so the write prunes it.
    expect(records(update.sessionState)).toEqual([]);
  });

  it("replies to a ctx.agent caller when its call fails", async () => {
    const update = await start([
      { ...modelCall({ target: "missing" }), workflowCaller: { replyTo: "reply", runId: "run-1" } },
    ]);

    expect(update.results).toEqual([]);
    expect(update.replies).toEqual([
      {
        replyTo: "reply",
        result: {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          origin: "dispatch",
          output: {
            code: "EXECUTION_FAILED",
            message: 'Agent target "missing" is not available to this agent.',
          },
          subagentName: "missing",
        },
      },
    ]);
    // No task exists for a call rejected before its record, so nothing is reported.
    expect(update.events).toEqual([]);
    expect(prepareActionDispatch).not.toHaveBeenCalled();
  });

  it("rejects a taskId the session does not know instead of starting a new agent", async () => {
    const update = await start([modelCall({ taskId: "research-zzzzzz" })]);

    expect(update.results).toEqual([
      expect.objectContaining({
        callId: "call-1",
        isError: true,
        output: expect.objectContaining({ code: "UNKNOWN_TASK" }),
      }),
    ]);
    expect(update.events).toEqual([]);
    expect(startSubagent).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual([]);
  });

  it("refuses to continue an agent whose child never started", async () => {
    const { table } = cancelTask(
      taskTable([createTaskRecord({ callId: "call-0" })]),
      "research-abc234",
      NOW,
    );

    const update = await start([modelCall({ taskId: "research-abc234" })], table.records);

    expect(update.results).toEqual([
      expect.objectContaining({
        callId: "call-1",
        isError: true,
        output: expect.objectContaining({ code: "UNKNOWN_TASK" }),
      }),
    ]);
    // The rejection neither created nor advanced a generation.
    expect(update.events).toEqual([]);
    expect(startSubagent).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual(table.records);
  });

  it("tells a ctx.agent caller that a working agent cannot take its call", async () => {
    const working = createTaskRecord({ callId: "call-0", child: LOCAL_CHILD });

    const update = await start(
      [
        {
          ...modelCall({ taskId: working.id }),
          workflowCaller: { replyTo: "reply", runId: "run-1" },
        },
      ],
      [working],
    );

    expect(update.replies).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          isError: true,
          output: expect.objectContaining({ code: "TASK_BUSY" }),
        }),
      }),
    ]);
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual([working]);
  });

  it("gives an idle agent its next generation with the owner inbox as the caller", async () => {
    const idle = createTaskRecord({
      callId: "call-0",
      child: LOCAL_CHILD,
      delivered: true,
      lastStatus: "Found three sources.",
      status: "completed",
      turnId: "turn-0",
    });

    const update = await start(
      [modelCall({ taskId: idle.id, message: "Summarize them." })],
      [idle],
    );

    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith({
      command: {
        auth: null,
        caller: {
          activityObserver: undefined,
          callId: "call-1",
          replyTo: { kind: "hook", token: OWNER_INBOX },
          subagentName: "research",
        },
        kind: "send",
        operationId: "turn-1:call-1",
        payload: { message: "Summarize them.", outputSchema: undefined },
        turnPolicy: "queue",
      },
      sessionId: "child-session",
    });
    expect(startSubagent).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({
        callId: "call-1",
        child: LOCAL_CHILD,
        delivered: false,
        generation: 2,
        id: idle.id,
        status: "working",
        turnId: "turn-1",
      }),
    ]);
    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          child: { sessionId: "child-session", streamPath: "/eve/v1/session/child-session/stream" },
          generation: 2,
          kind: "agent",
          mode: "detached",
          name: "research",
          resumable: true,
          taskId: idle.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
  });
});

describe("detached agent calls", () => {
  it("commits a detached record with its creator, starts the child, and returns the receipt", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });

    const update = await start([modelCall()]);

    const [record] = records(update.sessionState);
    expect(record).toMatchObject({
      callId: "call-1",
      creator: { auth: null },
      mode: "detached",
      status: "working",
    });
    expect(startSubagent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ parentContinuationToken: OWNER_INBOX, taskId: record?.id }),
    );
    expect(update.results).toEqual([
      {
        callId: "call-1",
        kind: "tool-result",
        modelOutput: renderStartReceipt(record!, "research"),
        output: { status: "working", taskId: record?.id },
        toolName: "research",
      },
    ]);
    // A local child announces itself when it reports task.started.
    expect(update.events).toEqual([]);
  });

  it("retires the idle agent that started least recently once too many are idle", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });
    const idle = Array.from({ length: MAX_RETAINED_IDLE_TASKS + 1 }, (_, index) =>
      createTaskRecord({
        callId: `call-idle-${String(index)}`,
        child: {
          continuationToken: `idle-token-${String(index)}`,
          kind: "local",
          sessionId: `idle-session-${String(index)}`,
        },
        delivered: true,
        id: `research-idle${String(index).padStart(2, "0")}`,
        startedAt: new Date(Date.parse(NOW) - (index + 1) * 60_000).toISOString(),
        status: "completed",
      }),
    );

    const update = await start([modelCall()], idle);

    const oldest = idle.at(-1)!;
    expect(records(update.sessionState).map((record) => record.id)).not.toContain(oldest.id);
    expect(records(update.sessionState)).toHaveLength(MAX_RETAINED_IDLE_TASKS + 1);
    expect(requestWorkflowSessionEnd).toHaveBeenCalledExactlyOnceWith({
      reason: "The parent retired this idle task.",
      sessionId: `idle-session-${String(MAX_RETAINED_IDLE_TASKS)}`,
    });
    // The request reached the agent, so nothing needs a hard stop.
    expect(armChildHardStop).not.toHaveBeenCalled();
  });

  it("arms a timer that asks a retired idle agent again when the request to end did not reach it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });
    vi.mocked(requestWorkflowSessionEnd).mockRejectedValue(
      new Error("moving to another deployment"),
    );
    const idle = Array.from({ length: MAX_RETAINED_IDLE_TASKS + 1 }, (_, index) =>
      createTaskRecord({
        callId: `call-idle-${String(index)}`,
        child: {
          continuationToken: `idle-token-${String(index)}`,
          kind: "local",
          sessionId: `idle-session-${String(index)}`,
        },
        delivered: true,
        id: `research-idle${String(index).padStart(2, "0")}`,
        startedAt: new Date(Date.parse(NOW) - (index + 1) * 60_000).toISOString(),
        status: "completed",
      }),
    );

    try {
      await start([modelCall()], idle);

      expect(armChildHardStop).toHaveBeenCalledExactlyOnceWith({
        endReason: "The parent retired this idle task.",
        ownerSessionId: "parent",
        targets: [idle.at(-1)!.child],
        wakeAt: "2026-09-24T14:00:30.000Z",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("holds the detached result for its own task.result message, not the tool result", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });
    const started = await start([modelCall()]);
    const adopted = await applyTaskReport({
      now: NOW,
      payload: {
        callId: "call-1",
        child: { continuationToken: "child-token", sessionId: "child-session" },
        kind: "task.started",
      },
      serializedContext: {},
      sessionState: started.sessionState,
    });
    expect(adopted.events).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ mode: "detached" }) }),
    ]);

    const settled = await applyTaskReport({
      now: NOW,
      payload: resultPayload(
        childResult({
          kind: "parked",
          result: { kind: "succeeded", output: "Draft: Orbit ships today." },
          usageDelta: ZERO_USAGE,
        }),
      ),
      serializedContext: {},
      sessionState: adopted.sessionState,
    });

    expect(settled.results).toEqual([]);
    expect(settledTaskIds(settled.events)).toHaveLength(1);
    const session = readDurableSession(settled.sessionState);
    expect(readPendingTaskResults(session.state)).toEqual([
      expect.objectContaining({
        outcome: { output: "Draft: Orbit ships today.", status: "completed" },
        taskId: records(started.sessionState)[0]?.id,
      }),
    ]);
    expect(records(settled.sessionState)[0]).toMatchObject({ delivered: false });
  });

  it("awaits a ctx.agent call for its workflow body instead of returning a receipt", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });

    const update = await start([
      { ...modelCall(), workflowCaller: { replyTo: "reply", runId: "run-1" } },
    ]);

    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({ mode: "attached", status: "working" }),
    ]);
    expect(update.results).toEqual([]);
    expect(update.replies).toEqual([]);
    expect(startSubagent).toHaveBeenCalledOnce();
  });

  it("rejects a start over the cap without starting it, counting detached workflow tasks too", async () => {
    const working = Array.from({ length: MAX_WORKING_TASKS }, (_, index) =>
      createTaskRecord({
        callId: `call-bg-${index}`,
        id: `remind-bg${String(index).padStart(4, "0")}`,
        kind: "workflow",
        mode: "detached",
        name: "remind",
      }),
    );

    const update = await start([modelCall()], working);

    expect(update.results).toEqual([
      {
        callId: "call-1",
        isError: true,
        kind: "tool-result",
        output: {
          code: "TOO_MANY_TASKS",
          message: expect.stringMatching(
            /^20 tasks are already working \(.+\)\. Wait for one with task_wait or stop one with task_cancel, then try again\.$/u,
          ),
        },
        toolName: "research",
      },
    ]);
    expect(startSubagent).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual(working);
  });

  it("rejects a send to an idle agent over the cap, but not one to a working agent", async () => {
    const working = Array.from({ length: MAX_WORKING_TASKS - 1 }, (_, index) =>
      createTaskRecord({
        callId: `call-bg-${index}`,
        id: `remind-bg${String(index).padStart(4, "0")}`,
        kind: "workflow",
        mode: "detached",
        name: "remind",
      }),
    );
    const busy = createTaskRecord({
      callId: "call-busy",
      child: LOCAL_CHILD,
      id: "research-busy01",
      mode: "detached",
      turnId: "turn-0",
    });
    const idle = createTaskRecord({
      callId: "call-idle",
      child: { ...LOCAL_CHILD, sessionId: "idle-session" },
      delivered: true,
      id: "research-idle01",
      mode: "detached",
      status: "completed",
      turnId: "turn-0",
    });

    const update = await start(
      [
        modelCall({ taskId: idle.id, callId: "call-more", message: "Now the FAQ." }),
        modelCall({ taskId: busy.id, callId: "call-steer", message: "Shorter, please." }),
      ],
      [...working, busy, idle],
    );

    expect(update.results).toEqual([
      expect.objectContaining({
        callId: "call-more",
        isError: true,
        output: expect.objectContaining({ code: "TOO_MANY_TASKS" }),
      }),
      expect.objectContaining({
        callId: "call-steer",
        modelOutput: renderSendReceipt(busy, false),
      }),
    ]);
    expect(records(update.sessionState).find((record) => record.id === idle.id)).toEqual(idle);
  });

  it("gives an idle agent a new detached generation", async () => {
    const idle = createTaskRecord({
      callId: "call-0",
      child: LOCAL_CHILD,
      delivered: true,
      status: "completed",
      turnId: "turn-0",
    });

    const update = await start([modelCall({ taskId: idle.id, message: "Now the FAQ." })], [idle]);

    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith({
      command: expect.objectContaining({
        caller: expect.objectContaining({ callId: "call-1" }),
        payload: { message: "Now the FAQ.", outputSchema: undefined },
      }),
      sessionId: "child-session",
    });
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({ generation: 2, id: idle.id, mode: "detached" }),
    ]);
    expect(update.results).toEqual([
      expect.objectContaining({ modelOutput: renderSendReceipt(idle, true) }),
    ]);
  });
});

describe("sends to a working agent", () => {
  const working = createTaskRecord({
    callId: "call-0",
    child: LOCAL_CHILD,
    mode: "detached",
    turnId: "turn-0",
  });
  const ALICE = {
    attributes: {},
    authenticator: "slack",
    principalId: "U-alice",
    principalType: "user",
  } as const;
  const BOB = { ...ALICE, principalId: "U-bob" } as const;
  const steer = (message: string, seq = 1) => ({
    command: {
      caller: {
        callId: "call-0",
        replyTo: { kind: "hook", token: OWNER_INBOX },
        subagentName: "research",
      },
      kind: "send",
      operationId: `${working.id}:${String(seq)}`,
      payload: { message },
      turnPolicy: "steer",
    },
    sessionId: "child-session",
  });
  const sent = { callId: "call-1", seq: 1, turnId: "turn-1" };
  const answer = (output: string, steers?: number) => {
    const result: ChildTaskReport = {
      ...childResult({
        kind: "parked",
        result: { kind: "succeeded", output },
        usageDelta: ZERO_USAGE,
      }),
      callId: "call-0",
      steers,
    };
    return resultPayload(result);
  };
  const asPrincipal = (auth: typeof ALICE | typeof BOB) => {
    const base = vi.mocked(prepareActionDispatch).getMockImplementation()!;
    vi.mocked(prepareActionDispatch).mockImplementation(async (input) => ({
      ...(await base(input)),
      auth,
      creator: { auth },
    }));
  };

  it("sends the input for the call the agent is answering and returns the send receipt", async () => {
    const update = await start(
      [modelCall({ taskId: working.id, message: "Also cover pricing." })],
      [working],
    );

    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith(steer("Also cover pricing."));
    expect(update.results).toEqual([
      {
        callId: "call-1",
        kind: "tool-result",
        modelOutput: renderSendReceipt(working, false),
        output: { status: "working", taskId: working.id },
        toolName: "research",
      },
    ]);
    // No new generation and no task.started; the owner records the send it numbered.
    expect(update.events).toEqual([]);
    expect(records(update.sessionState)).toEqual([{ ...working, lastSeq: 1, sends: [sent] }]);
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it("sends a new output schema with the input, which the agent's turn takes", async () => {
    const outputSchema = { properties: { items: { type: "array" } }, type: "object" };
    await start(
      [
        {
          ...modelCall({ taskId: working.id, message: "Return a list instead." }),
          input: {
            message: "Return a list instead.",
            outputSchema,
            target: "research",
            taskId: working.id,
          },
        },
      ],
      [working],
    );

    const expected = steer("Return a list instead.");
    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith({
      ...expected,
      command: {
        ...expected.command,
        payload: { message: "Return a list instead.", outputSchema },
      },
    });
  });

  it("resends the same key when a retried step sends again, so the agent admits it once", async () => {
    const call = modelCall({ taskId: working.id, message: "Also cover pricing." });
    await start([call], [working]);
    await start([call], [working]);

    expect(dispatchSession.mock.calls).toEqual([
      [steer("Also cover pricing.")],
      [steer("Also cover pricing.")],
    ]);
  });

  it("holds the send for an agent that has not started, and sends it when it starts", async () => {
    const unstarted = createTaskRecord({ callId: "call-0", mode: "detached", turnId: "turn-0" });

    const update = await start(
      [modelCall({ taskId: unstarted.id, message: "Also cover pricing." })],
      [unstarted],
    );

    expect(dispatchSession).not.toHaveBeenCalled();
    expect(update.results).toEqual([
      expect.objectContaining({ modelOutput: renderSendReceipt(unstarted, false) }),
    ]);
    const held = { input: { message: "Also cover pricing." }, kind: "input", seq: 1 };
    expect(records(update.sessionState)).toEqual([
      { ...unstarted, lastSeq: 1, pendingCommands: [held], sends: [sent] },
    ]);

    const adopted = await applyTaskReport({
      now: NOW,
      payload: {
        callId: "call-0",
        child: { continuationToken: "child-token", sessionId: "child-session" },
        kind: "task.started",
      },
      serializedContext: {},
      sessionState: update.sessionState,
    });

    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith(steer("Also cover pricing."));
    expect(records(adopted.sessionState)).toEqual([
      { ...unstarted, announced: true, child: LOCAL_CHILD, lastSeq: 1, sends: [sent] },
    ]);
  });

  it("forgets a held send it cannot deliver when the agent starts", async () => {
    const unstarted = createTaskRecord({ callId: "call-0", mode: "detached", turnId: "turn-0" });
    const update = await start([modelCall({ taskId: unstarted.id })], [unstarted]);
    dispatchSession.mockResolvedValueOnce({ status: "session_not_active" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const adopted = await applyTaskReport({
      now: NOW,
      payload: {
        callId: "call-0",
        child: { continuationToken: "child-token", sessionId: "child-session" },
        kind: "task.started",
      },
      serializedContext: {},
      sessionState: update.sessionState,
    });

    expect(records(adopted.sessionState)).toEqual([
      { ...unstarted, announced: true, child: LOCAL_CHILD, lastSeq: 1 },
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("a held send did not reach its task"),
      expect.objectContaining({ taskId: unstarted.id }),
    );
    error.mockRestore();
  });

  it("delivers exactly one result when the agent answered after receiving the message", async () => {
    const steered = await start(
      [modelCall({ taskId: working.id, message: "Also cover pricing." })],
      [working],
    );

    const first = await applyTaskReport({
      now: NOW,
      payload: answer("Draft with pricing.", 1),
      serializedContext: {},
      sessionState: steered.sessionState,
    });
    const repeated = await applyTaskReport({
      now: NOW,
      payload: answer("Draft with pricing.", 1),
      serializedContext: {},
      sessionState: first.sessionState,
    });

    expect(settledTaskIds(first.events)).toEqual([working.id]);
    expect(first.events.map((event) => event.type)).toEqual(["task.settled"]);
    expect(readPendingTaskResults(readDurableSession(first.sessionState).state)).toHaveLength(1);
    expect(records(first.sessionState)[0]).toMatchObject({ generation: 1, status: "completed" });
    expect(repeated.events).toEqual([]);
    expect(readPendingTaskResults(readDurableSession(repeated.sessionState).state)).toHaveLength(1);
  });

  it("runs a message that reached the agent after it answered as its next detached generation", async () => {
    // Alice's writer answers while the owner is mid-step; its answer waits in
    // the owner's inbox as the model sends the writer a correction.
    const steered = await start(
      [modelCall({ taskId: working.id, message: "Also cover pricing." })],
      [working],
    );

    const answered = await applyTaskReport({
      now: NOW,
      payload: answer("Draft without pricing."),
      serializedContext: {},
      sessionState: steered.sessionState,
    });

    // The answer settles its generation and is held for the model. The
    // correction became the agent's next turn, which answers the same call
    // and is tracked as the send's generation, whose result arrives later.
    expect(answered.events.map((event) => event.type)).toEqual(["task.settled", "task.started"]);
    expect(answered.events[1]).toMatchObject({
      data: { callId: "call-1", mode: "detached", taskId: working.id, turnId: "turn-1" },
    });
    expect(records(answered.sessionState)).toEqual([
      expect.objectContaining({
        callId: "call-1",
        childCallId: "call-0",
        delivered: false,
        generation: 2,
        mode: "detached",
        sends: [sent],
        startedBy: 1,
        status: "working",
      }),
    ]);
    const held = readDurableSession(answered.sessionState).state;
    expect(readPendingTaskResults(held)).toEqual([
      expect.objectContaining({ generation: 1, taskId: working.id }),
    ]);

    const continued = await applyTaskReport({
      now: NOW,
      payload: answer("Draft with pricing.", 1),
      serializedContext: {},
      sessionState: answered.sessionState,
    });

    expect(continued.events.map((event) => event.type)).toEqual(["task.settled"]);
    expect(readPendingTaskResults(readDurableSession(continued.sessionState).state)).toEqual([
      expect.objectContaining({ generation: 1 }),
      expect.objectContaining({
        generation: 2,
        outcome: { output: "Draft with pricing.", status: "completed" },
      }),
    ]);
    expect(records(continued.sessionState)[0]?.sends).toBeUndefined();
  });

  it("returns TASK_UNREACHABLE instead of a receipt when the input does not arrive", async () => {
    dispatchSession.mockResolvedValueOnce({ retryable: true, status: "session_not_active" });

    const update = await start([modelCall({ taskId: working.id })], [working]);

    expect(update.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.objectContaining({ code: "TASK_UNREACHABLE" }),
      }),
    ]);
    // The send is taken back, but its number is spent, so a retry is a new message.
    expect(records(update.sessionState)).toEqual([{ ...working, lastSeq: 1 }]);
    const retried = await start(
      [modelCall({ callId: "call-2", taskId: working.id })],
      records(update.sessionState),
    );
    expect(dispatchSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ operationId: `${working.id}:2` }),
      }),
    );
    expect(records(retried.sessionState)[0]?.sends).toEqual([
      { callId: "call-2", seq: 2, turnId: "turn-1" },
    ]);
  });

  it("ends a working agent whose session is gone for good", async () => {
    dispatchSession.mockResolvedValueOnce({ status: "session_not_active" });

    const update = await start([modelCall({ taskId: working.id })], [working]);

    expect(update.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.objectContaining({
          code: "TASK_UNREACHABLE",
          message: expect.stringContaining("its agent session ended"),
        }),
      }),
    ]);
    expect(update.events.map((event) => event.type)).toEqual(["task.settled", "task.ended"]);
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({ ended: true, generation: 1, status: "failed" }),
    ]);
    expect(readPendingTaskResults(readDurableSession(update.sessionState).state)).toEqual([
      expect.objectContaining({ generation: 1, taskId: working.id }),
    ]);
  });

  it("lets only the principal that started the agent's work send to it", async () => {
    // Alice started the writer in a shared thread; Bob's turn names it.
    const alices = { ...working, creator: encodeTaskCreator({ auth: ALICE }) };
    asPrincipal(BOB);

    const update = await start([modelCall({ taskId: alices.id, message: "Drop it." })], [alices]);

    expect(dispatchSession).not.toHaveBeenCalled();
    expect(update.results).toEqual([
      {
        callId: "call-1",
        isError: true,
        kind: "tool-result",
        output: { code: "TASK_OTHER_PRINCIPAL", message: renderTaskOtherPrincipal(alices.id) },
        toolName: "research",
      },
    ]);
    expect(records(update.sessionState)).toEqual([alices]);

    asPrincipal(ALICE);
    const own = await start([modelCall({ taskId: alices.id, message: "Shorter." })], [alices]);
    expect(own.results).toEqual([
      expect.objectContaining({ modelOutput: renderSendReceipt(alices, false) }),
    ]);
  });

  it("lets only the principal that started an idle agent give it more work", async () => {
    // Alice's researcher answered and is idle; in the shared thread, Bob's
    // turn names it. Its session holds Alice's conversation and acts for her.
    const idle = createTaskRecord({
      callId: "call-0",
      child: LOCAL_CHILD,
      creator: encodeTaskCreator({ auth: ALICE }),
      delivered: true,
      lastStatus: "Found three sources.",
      status: "completed",
      turnId: "turn-0",
    });
    asPrincipal(BOB);

    const update = await start(
      [modelCall({ taskId: idle.id, message: "Summarize them for me." })],
      [idle],
    );

    expect(dispatchSession).not.toHaveBeenCalled();
    expect(startSubagent).not.toHaveBeenCalled();
    expect(update.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: { code: "TASK_OTHER_PRINCIPAL", message: renderTaskOtherPrincipal(idle.id) },
      }),
    ]);
    expect(update.events).toEqual([]);
    expect(records(update.sessionState)).toEqual([idle]);

    asPrincipal(ALICE);
    const own = await start([modelCall({ taskId: idle.id, message: "Summarize them." })], [idle]);
    expect(own.results).toEqual([
      expect.objectContaining({ modelOutput: renderSendReceipt(idle, true) }),
    ]);
    expect(records(own.sessionState)).toEqual([
      expect.objectContaining({ generation: 2, id: idle.id, status: "working" }),
    ]);
  });

  it("returns TASK_BUSY when a workflow body started the agent's current work", async () => {
    const workflowOwned = {
      ...working,
      mode: "attached" as const,
      workflowCaller: { replyTo: "reply", runId: "run-1" },
    };

    const update = await start(
      [modelCall({ taskId: workflowOwned.id, message: "Return a list instead." })],
      [workflowOwned],
    );

    expect(dispatchSession).not.toHaveBeenCalled();
    expect(update.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: {
          code: "TASK_BUSY",
          message: expect.stringContaining("is working for a workflow tool call"),
        },
      }),
    ]);
    expect(records(update.sessionState)).toEqual([workflowOwned]);
  });
});

describe("applyTaskReport", () => {
  it("adopts a local child on task.started and announces it", async () => {
    const record = createTaskRecord();

    const update = await applyTaskReport({
      now: NOW,
      payload: {
        callId: "call-1",
        child: { continuationToken: "child-token", sessionId: "child-session" },
        kind: "task.started",
      },
      serializedContext: {},
      sessionState: ownerState([record]),
    });

    expect(records(update.sessionState)).toEqual([
      { ...record, announced: true, child: LOCAL_CHILD },
    ]);
    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          child: { sessionId: "child-session", streamPath: "/eve/v1/session/child-session/stream" },
          generation: 1,
          kind: "agent",
          mode: "attached",
          name: "research",
          resumable: true,
          taskId: record.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
    expect(update.results).toEqual([]);
  });

  it("sends the held cancel when a cancelled task's child starts", async () => {
    const { table } = cancelTask(taskTable([createTaskRecord()]), "research-abc234", NOW);

    const update = await applyTaskReport({
      now: NOW,
      payload: {
        callId: "call-1",
        child: { continuationToken: "child-token", sessionId: "child-session" },
        kind: "task.started",
      },
      serializedContext: {},
      sessionState: ownerState(table.records),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(update.events).toEqual([]);
    const [record] = records(update.sessionState);
    expect(record).toMatchObject({ child: LOCAL_CHILD, status: "cancelled" });
    expect(record?.pendingCommands).toBeUndefined();
  });

  it("cancels a child whose task was cancelled and pruned before it reported task.started", async () => {
    // Alice's turn starts a research agent, and she cancels it before the child boots.
    const cancelled = cancelTask(taskTable([createTaskRecord()]), "research-abc234", NOW);
    expect(cancelled.table.records[0]?.pendingCommands).toEqual([{ kind: "cancel" }]);
    // The confirmation window passes with no child to stop: the task ends and is pruned.
    const expired = evaluateTaskDeadlines(cancelled.table, "2026-09-24T14:00:31.000Z");
    expect(expired.effects).toEqual([
      expect.objectContaining({ kind: "unconfirmed" }),
      expect.objectContaining({ kind: "ended" }),
    ]);
    expect(expired.effects[0]).not.toHaveProperty("child");
    expect(pruneTaskTable(expired.table).records).toEqual([]);

    // The child boots late and reports to an owner that no longer knows its task.
    const update = await applyTaskReport({
      now: "2026-09-24T14:01:00.000Z",
      payload: {
        callId: "call-1",
        child: { continuationToken: "child-token", sessionId: "child-session" },
        kind: "task.started",
      },
      serializedContext: {},
      sessionState: ownerState(pruneTaskTable(expired.table).records),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(records(update.sessionState)).toEqual([]);
  });

  it("ignores a repeated task.started from a child the owner already adopted", async () => {
    const record = createTaskRecord({ child: LOCAL_CHILD });

    const update = await applyTaskReport({
      now: NOW,
      payload: {
        callId: "call-1",
        child: { continuationToken: "child-token", sessionId: "child-session" },
        kind: "task.started",
      },
      serializedContext: {},
      sessionState: ownerState([record]),
    });

    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    expect(update.events).toEqual([]);
    expect(records(update.sessionState)).toEqual([record]);
  });

  it.each(["parked", "terminal"] as const)(
    "settles a model call from a %s child result",
    async (kind) => {
      const record = createTaskRecord({ child: LOCAL_CHILD });

      const update = await applyTaskReport({
        now: NOW,
        payload: resultPayload(
          childResult({
            kind,
            result: { kind: "succeeded", output: "Found three sources." },
            usageDelta: { ...ZERO_USAGE, inputTokens: 2, outputTokens: 3 },
          }),
        ),
        serializedContext: {},
        sessionState: ownerState([record]),
      });

      expect(update.results).toEqual([
        {
          callId: "call-1",
          kind: "tool-result",
          output: "Found three sources.",
          toolName: "research",
        },
      ]);
      const settled = {
        data: {
          callId: "call-1",
          generation: 1,
          output: "Found three sources.",
          status: "completed",
          taskId: record.id,
          usage: { ...ZERO_USAGE, inputTokens: 2, outputTokens: 3 },
        },
        type: "task.settled",
      };
      // A child whose session ended with this answer ends its task.
      expect(update.events).toEqual(
        kind === "terminal"
          ? [settled, { data: { taskId: record.id }, type: "task.ended" }]
          : [settled],
      );
      expect(update.replies).toEqual([]);
      // A parked child stays listed as an idle agent; one whose session ended is dropped.
      expect(records(update.sessionState)).toEqual(
        kind === "parked"
          ? [
              expect.objectContaining({
                child: LOCAL_CHILD,
                delivered: true,
                lastStatus: "Found three sources.",
                status: "completed",
              }),
            ]
          : [],
      );
      expect(getSessionTokenUsage(readDurableSession(update.sessionState))).toMatchObject({
        inputTokens: 2,
        outputTokens: 3,
      });
    },
  );

  it("returns a failed child result as an error and reports the failure", async () => {
    const error = { code: "EXECUTION_FAILED", message: "The child failed." };

    const update = await applyTaskReport({
      now: NOW,
      payload: resultPayload({
        ...childResult({
          kind: "parked",
          result: { error, kind: "failed" },
          usageDelta: ZERO_USAGE,
        }),
        isError: true,
        output: error,
      }),
      serializedContext: {},
      sessionState: ownerState([createTaskRecord({ child: LOCAL_CHILD })]),
    });

    expect(update.results).toEqual([
      { callId: "call-1", isError: true, kind: "tool-result", output: error, toolName: "research" },
    ]);
    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          error,
          generation: 1,
          status: "failed",
          taskId: "research-abc234",
          usage: ZERO_USAGE,
        },
        type: "task.settled",
      },
    ]);
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({ lastStatus: "Failed: The child failed.", status: "failed" }),
    ]);
  });

  it("replies to the ctx.agent caller instead of returning a tool result", async () => {
    const result = childResult({
      kind: "parked",
      result: { kind: "succeeded", output: "done" },
      usageDelta: ZERO_USAGE,
    });

    const update = await applyTaskReport({
      now: NOW,
      payload: resultPayload(result),
      serializedContext: {},
      sessionState: ownerState([
        createTaskRecord({
          child: LOCAL_CHILD,
          workflowCaller: { replyTo: "reply", runId: "run-1" },
        }),
      ]),
    });

    expect(update.results).toEqual([]);
    expect(update.replies).toEqual([{ replyTo: "reply", result }]);
    expect(update.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ output: "done", status: "completed" }),
        type: "task.settled",
      }),
    ]);
  });

  it("drops a duplicate or unknown result", async () => {
    const payload = resultPayload(
      childResult({
        kind: "parked",
        result: { kind: "succeeded", output: "done" },
        usageDelta: { ...ZERO_USAGE, inputTokens: 2 },
      }),
    );
    const first = await applyTaskReport({
      now: NOW,
      payload,
      serializedContext: {},
      sessionState: ownerState([createTaskRecord({ child: LOCAL_CHILD })]),
    });
    const restored = JSON.parse(JSON.stringify(first.sessionState)) as DurableSessionState;

    for (const report of [payload, resultPayload({ ...payload.results[0]!, callId: "call-x" })]) {
      const dropped = await applyTaskReport({
        now: NOW,
        payload: report,
        serializedContext: {},
        sessionState: restored,
      });
      expect(dropped).toMatchObject({ events: [], replies: [], results: [] });
      expect(dropped.sessionState).toBe(restored);
    }
    expect(getSessionTokenUsage(readDurableSession(restored))).toMatchObject({ inputTokens: 2 });
  });
  describe("source binding", () => {
    const remoteRecord = createTaskRecord({
      child: REMOTE_CHILD,
      id: "billing-abc234",
      name: "billing",
      nodeId: "subagents/billing.ts",
    });
    const done = {
      kind: "parked" as const,
      result: { kind: "succeeded" as const, output: "done" },
      usageDelta: ZERO_USAGE,
    };
    const localResult = childResult(done);
    const remoteResult = { ...childResult(done), subagentName: "billing" };

    it.each([
      [
        "a remote-stamped result for a local task",
        createTaskRecord({ child: LOCAL_CHILD }),
        resultPayload(localResult, { kind: "remote", sessionId: "child-session" }),
      ],
      ["an unstamped result for a remote task", remoteRecord, resultPayload(remoteResult)],
      [
        "a result from another remote session",
        remoteRecord,
        resultPayload(remoteResult, { kind: "remote", sessionId: "other-remote" }),
      ],
      [
        "a result naming another agent",
        createTaskRecord({ child: LOCAL_CHILD }),
        resultPayload({ ...localResult, subagentName: "billing" }),
      ],
    ])("drops %s", async (_name, record, payload) => {
      const state = ownerState([record]);

      const update = await applyTaskReport({
        now: NOW,
        payload,
        serializedContext: {},
        sessionState: state,
      });

      expect(update).toMatchObject({ events: [], replies: [], results: [] });
      expect(update.sessionState).toBe(state);
      expect(records(update.sessionState)).toEqual([record]);
    });

    it("settles a remote task from a result stamped with the session it reported", async () => {
      const update = await applyTaskReport({
        now: NOW,
        payload: resultPayload(remoteResult, { kind: "remote", sessionId: "remote-child" }),
        serializedContext: {},
        sessionState: ownerState([remoteRecord]),
      });

      expect(update.results).toEqual([
        { callId: "call-1", kind: "tool-result", output: "done", toolName: "billing" },
      ]);
    });

    it("ignores a remote result that does not name its session", async () => {
      const update = await applyTaskReport({
        now: NOW,
        payload: resultPayload(remoteResult, { kind: "remote" }),
        serializedContext: {},
        sessionState: ownerState([remoteRecord]),
      });

      expect(update.results).toEqual([]);
      expect(records(update.sessionState)).toEqual([remoteRecord]);
    });
  });

  it("reports a cancellation the child made on its own", async () => {
    const update = await applyTaskReport({
      now: NOW,
      payload: resultPayload(
        childResult({ kind: "parked", result: { kind: "cancelled" }, usageDelta: ZERO_USAGE }),
      ),
      serializedContext: {},
      sessionState: ownerState([createTaskRecord({ child: LOCAL_CHILD })]),
    });

    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          generation: 1,
          status: "cancelled",
          taskId: "research-abc234",
          usage: ZERO_USAGE,
        },
        type: "task.settled",
      },
    ]);
    expect(update.results).toEqual([
      expect.objectContaining({ callId: "call-1", isError: true, kind: "tool-result" }),
    ]);
  });

  it("counts a cancelled child's confirmation without reporting it", async () => {
    const { table } = cancelTask(
      taskTable([
        createTaskRecord({
          child: LOCAL_CHILD,
          workflowCaller: { replyTo: "reply", runId: "run-1" },
        }),
      ]),
      "research-abc234",
      NOW,
    );
    const payload = resultPayload(
      childResult({
        kind: "parked",
        result: { kind: "cancelled" },
        usageDelta: { ...ZERO_USAGE, inputTokens: 5, outputTokens: 1 },
      }),
    );

    const update = await applyTaskReport({
      now: NOW,
      payload,
      serializedContext: {},
      sessionState: ownerState(table.records),
    });

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(getSessionTokenUsage(readDurableSession(update.sessionState))).toMatchObject({
      inputTokens: 5,
      outputTokens: 1,
    });
    const [record] = records(update.sessionState);
    expect(record).toMatchObject({
      child: LOCAL_CHILD,
      lastStatus: "Cancelled.",
      status: "cancelled",
    });
    expect(record?.cancelConfirmBy).toBeUndefined();

    const repeated = await applyTaskReport({
      now: NOW,
      payload,
      serializedContext: {},
      sessionState: update.sessionState,
    });
    expect(repeated.sessionState).toBe(update.sessionState);
  });
});

describe("cancelTasksStep", () => {
  it("cancels one turn's working tasks and signals the started children", async () => {
    const started = createTaskRecord({ child: LOCAL_CHILD, id: "research-aaaaaa" });
    const starting = createTaskRecord({ callId: "call-2", id: "research-bbbbbb" });
    const otherTurn = createTaskRecord({
      callId: "call-3",
      child: { ...LOCAL_CHILD, sessionId: "other-child" },
      id: "research-cccccc",
      turnId: "turn-0",
    });
    const finished = createTaskRecord({
      callId: "call-4",
      id: "research-dddddd",
      status: "completed",
    });

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-1" },
      serializedContext: {},
      sessionState: ownerState([started, starting, otherTurn, finished]),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    // A task cancelled before its child started starts with no child, then settles.
    expect(events).toEqual([
      {
        data: { callId: "call-1", generation: 1, status: "cancelled", taskId: started.id },
        type: "task.settled",
      },
      {
        data: {
          callId: "call-2",
          generation: 1,
          kind: "agent",
          mode: "attached",
          name: "research",
          resumable: true,
          taskId: starting.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
      {
        data: { callId: "call-2", generation: 1, status: "cancelled", taskId: starting.id },
        type: "task.settled",
      },
    ]);
    expect(records(sessionState)).toEqual([
      expect.objectContaining({ delivered: true, id: started.id, status: "cancelled" }),
      expect.objectContaining({
        id: starting.id,
        pendingCommands: [{ kind: "cancel" }],
        status: "cancelled",
      }),
      otherTurn,
      finished,
    ]);
  });

  it("cancels every working task, a detached run's own agent calls included", async () => {
    const reminder = createTaskRecord({
      child: { commandToken: "control-hook", kind: "workflow", runId: "run-remind" },
      id: "remind-aaaaaa",
      kind: "workflow",
      mode: "detached",
      name: "remind",
      turnId: "turn-0",
    });
    const reminderAgent = createTaskRecord({
      callId: "call-2",
      id: "research-bbbbbb",
      turnId: "turn-0",
      workflowCaller: { replyTo: "reply-hook", runId: "run-remind" },
    });
    const waited = createTaskRecord({ callId: "call-3", id: "research-cccccc" });

    const all = await cancelTasksStep({
      selector: { kind: "all" },
      serializedContext: {},
      sessionState: ownerState([reminder, reminderAgent, waited]),
    });

    expect(settledTaskIds(all.events)).toEqual([reminder.id, reminderAgent.id, waited.id]);
    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "control-hook", runId: "run-remind" },
      expect.any(String),
    );
  });

  it("cancels the turn's workflow tool calls through each run's control hook", async () => {
    const workflowCall = createTaskRecord({
      child: { commandToken: "control-hook", kind: "workflow", runId: "run-1" },
      id: "deploy-aaaaaa",
      kind: "workflow",
      name: "deploy",
    });

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-1" },
      serializedContext: {},
      sessionState: ownerState([workflowCall]),
    });

    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "control-hook", runId: "run-1" },
      expect.any(String),
    );
    // A workflow tool call is not resumable, so it ends with its only generation.
    expect(events).toEqual([
      {
        data: { callId: "call-1", generation: 1, status: "cancelled", taskId: workflowCall.id },
        type: "task.settled",
      },
      { data: { taskId: workflowCall.id }, type: "task.ended" },
    ]);
    // Kept until the run confirms it stopped.
    expect(records(sessionState)).toEqual([
      expect.objectContaining({
        cancelConfirmBy: expect.any(String),
        delivered: true,
        id: workflowCall.id,
        status: "cancelled",
      }),
    ]);
  });

  it("cancels only the tasks a finished workflow run started", async () => {
    const ownTask = createTaskRecord({
      child: LOCAL_CHILD,
      id: "research-aaaaaa",
      workflowCaller: { replyTo: "reply-1", runId: "run-1" },
    });
    const otherRun = createTaskRecord({
      callId: "call-2",
      id: "research-bbbbbb",
      workflowCaller: { replyTo: "reply-2", runId: "run-2" },
    });

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "workflow-run", runId: "run-1" },
      serializedContext: {},
      sessionState: ownerState([ownTask, otherRun]),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ status: "cancelled", taskId: ownTask.id }),
      }),
    ]);
    expect(records(sessionState)).toEqual([
      expect.objectContaining({ id: ownTask.id, status: "cancelled" }),
      otherRun,
    ]);
  });

  it("leaves the session untouched when no task matches", async () => {
    const state = ownerState([createTaskRecord({ turnId: "turn-0" })]);

    const cancelled = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-1" },
      serializedContext: {},
      sessionState: state,
    });

    expect(cancelled.sessionState).toBe(state);
    expect(cancelled.events).toEqual([]);
    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
  });

  it("reports one cancellation per generation, and nothing for the child's confirmation or a repeat", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD });

    const cancelled = await cancelTasksStep({
      selector: { kind: "all" },
      serializedContext: {},
      sessionState: ownerState([working]),
    });
    const repeated = await cancelTasksStep({
      selector: { kind: "all" },
      serializedContext: {},
      sessionState: cancelled.sessionState,
    });
    const confirmed = await applyTaskReport({
      now: NOW,
      payload: resultPayload(
        childResult({ kind: "parked", result: { kind: "cancelled" }, usageDelta: ZERO_USAGE }),
      ),
      serializedContext: {},
      sessionState: cancelled.sessionState,
    });

    expect(cancelled.events).toEqual([
      {
        data: { callId: "call-1", generation: 1, status: "cancelled", taskId: working.id },
        type: "task.settled",
      },
    ]);
    expect(repeated.events).toEqual([]);
    expect(repeated.sessionState).toBe(cancelled.sessionState);
    expect(confirmed).toMatchObject({ events: [], replies: [], results: [] });
  });
});

function settledTaskIds(events: readonly UnstampedMessageStreamEvent[]): string[] {
  return events.flatMap((event) => (event.type === "task.settled" ? [event.data.taskId] : []));
}

function modelCall(
  input: {
    readonly taskId?: string;
    readonly callId?: string;
    readonly message?: string;
    readonly target?: string;
  } = {},
): AgentTaskCall {
  const target = input.target ?? "research";
  const callInput: { taskId?: string; message: string; target: string } = {
    message: input.message ?? "Find sources.",
    target,
  };
  if (input.taskId !== undefined) callInput.taskId = input.taskId;
  return { callId: input.callId ?? "call-1", input: callInput, toolName: target };
}

async function start(
  calls: readonly AgentTaskCall[],
  existing: readonly TaskRecord[] = [],
  state: SessionStateMap = {},
) {
  return await startAgentTasks({
    callbackBaseUrl: "https://parent.example",
    calls,
    now: NOW,
    serializedContext: {},
    sessionState: ownerState(existing, state),
  });
}

function ownerState(
  existing: readonly TaskRecord[],
  state: SessionStateMap = {},
): DurableSessionState {
  const merged = { ...taskTableState(existing), ...state };
  return createDurableSessionState({
    session: setHarnessEmissionState(
      {
        agent: { dynamicModel: true, system: "", tools: [] },
        compaction: { recentWindowSize: 5, threshold: 10_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent",
        state: existing.length === 0 && Object.keys(state).length === 0 ? undefined : merged,
      },
      { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn-1" },
    ),
  });
}

function runtimeSession(durable: ReturnType<typeof readDurableSession>) {
  return {
    ...durable,
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
  };
}

function records(state: DurableSessionState): readonly TaskRecord[] {
  return getTaskTable(readDurableSession(state)).records;
}

function childResult(outcome: RuntimeSubagentChildResult["outcome"]): RuntimeSubagentChildResult {
  const turn = outcome.result;
  return {
    callId: "call-1",
    kind: "subagent-result",
    origin: "child",
    outcome,
    output: turn.kind === "succeeded" ? turn.output : "cancelled",
    subagentName: "research",
  };
}

function resultPayload(
  result: RuntimeSubagentChildResult,
  source?: RuntimeActionResultHookPayload["source"],
) {
  const payload: {
    kind: "runtime-action-result";
    results: RuntimeSubagentChildResult[];
    source?: RuntimeActionResultHookPayload["source"];
  } = { kind: "runtime-action-result", results: [result] };
  if (source !== undefined) payload.source = source;
  return payload;
}
