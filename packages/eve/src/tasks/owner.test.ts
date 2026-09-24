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
import { startSubagent } from "#execution/tools/subagent/start.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import {
  createWorkflowRuntime,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { getSessionTokenUsage } from "#harness/turn-tag-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionStateMap } from "#harness/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import {
  applyTaskReport,
  cancelTasksStep,
  ensureTaskCallbackAliasStep,
  startAgentTasks,
  type AgentTaskCall,
} from "#tasks/owner.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  getTaskTable,
  ownerInboxHookToken,
  readTaskCallbackAlias,
  TASK_CALLBACK_ALIAS_STATE_KEY,
} from "#tasks/state.js";
import { cancelTask } from "#tasks/table.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/coordination-dispatch-shared.js", () => ({ prepareActionDispatch: vi.fn() }));
vi.mock("#execution/tools/subagent/start.js", () => ({ startSubagent: vi.fn() }));
vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createWorkflowRuntime: vi.fn(),
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
  it("commits a record for a fresh local start and waits for the child to report", async () => {
    vi.mocked(startSubagent).mockResolvedValue({ kind: "started" });

    const update = await start([modelCall()]);

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    const [record] = records(update.sessionState);
    expect(record).toMatchObject({
      callId: "call-1",
      generation: 1,
      kind: "agent",
      mode: "foreground",
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
  ])("repeats no side effects for a replayed %s", async (_name, agentId) => {
    const existing = createTaskRecord();

    const update = await start([modelCall({ agentId })], [existing]);

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
          kind: "agent",
          mode: "foreground",
          name: "billing",
          taskId: record?.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
    expect(update.results).toEqual([]);
    // Remote children call back on the owner's unguessable alias, never its stable inbox.
    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentContinuationToken: sessionInboxHookToken(CALLBACK_ALIAS),
        taskId: record?.id,
      }),
    );
    expect(update.serializedContext).toEqual({});
  });

  it("refuses to start a remote child before the owner has a callback alias", async () => {
    await expect(start([modelCall({ target: "billing" })])).rejects.toThrow(
      "Remote agent tasks require the owner's callback alias.",
    );
    expect(startSubagent).not.toHaveBeenCalled();
  });

  it("returns the start error and keeps no record of an agent that never started", async () => {
    const output = { code: "SUBAGENT_START_FAILED", message: "The queue is unavailable." };
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
    // The child never started, so the task settles without a task.started.
    expect(update.events).toEqual([
      {
        data: { callId: "call-1", error: output, status: "failed", taskId },
        type: "task.settled",
      },
    ]);
    // The settled, delivered record has no child to continue, so the write prunes it.
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
            code: "SUBAGENT_EXECUTION_FAILED",
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

  it("rejects an agentId the session does not know instead of starting a new agent", async () => {
    const update = await start([modelCall({ agentId: "research-zzzzzz" })]);

    expect(update.results).toEqual([
      expect.objectContaining({
        callId: "call-1",
        isError: true,
        output: expect.objectContaining({ code: "UNKNOWN_AGENT" }),
      }),
    ]);
    expect(update.events).toEqual([]);
    expect(startSubagent).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual([]);
  });

  it("refuses to continue an agent whose child never started", async () => {
    const { table } = cancelTask(
      { records: [createTaskRecord({ callId: "call-0" })] },
      "research-abc234",
      NOW,
    );

    const update = await start([modelCall({ agentId: "research-abc234" })], table.records);

    expect(update.results).toEqual([
      expect.objectContaining({
        callId: "call-1",
        isError: true,
        output: expect.objectContaining({ code: "AGENT_UNREACHABLE" }),
      }),
    ]);
    // The rejection neither created nor advanced a generation.
    expect(update.events).toEqual([]);
    expect(startSubagent).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual(table.records);
  });

  it("rejects more work for an agent that is still working", async () => {
    const working = createTaskRecord({ callId: "call-0", child: LOCAL_CHILD });

    const update = await start([modelCall({ agentId: working.id })], [working]);

    expect(update.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.objectContaining({ code: "AGENT_BUSY" }),
      }),
    ]);
    expect(update.events).toEqual([]);
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
      [modelCall({ agentId: idle.id, message: "Summarize them." })],
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
        payload: { message: "Summarize them.", outputSchema: undefined },
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
          kind: "agent",
          mode: "foreground",
          name: "research",
          taskId: idle.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
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

    expect(records(update.sessionState)).toEqual([{ ...record, child: LOCAL_CHILD }]);
    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          child: { sessionId: "child-session", streamPath: "/eve/v1/session/child-session/stream" },
          kind: "agent",
          mode: "foreground",
          name: "research",
          taskId: record.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
    expect(update.results).toEqual([]);
  });

  it("sends the held cancel when a cancelled task's child starts", async () => {
    const { table } = cancelTask({ records: [createTaskRecord()] }, "research-abc234", NOW);

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
      expect(update.events).toEqual([
        {
          data: {
            callId: "call-1",
            output: "Found three sources.",
            status: "completed",
            taskId: record.id,
            usage: { ...ZERO_USAGE, inputTokens: 2, outputTokens: 3 },
          },
          type: "task.settled",
        },
      ]);
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
    const error = { code: "SESSION_FAILED", message: "The child failed." };

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

    it.each([
      ["with the session it reported", { kind: "remote" as const, sessionId: "remote-child" }],
      ["from an older deployment that omits its session", { kind: "remote" as const }],
    ])("settles a remote task from a remote-stamped result %s", async (_name, source) => {
      const update = await applyTaskReport({
        now: NOW,
        payload: resultPayload(remoteResult, source),
        serializedContext: {},
        sessionState: ownerState([remoteRecord]),
      });

      expect(update.results).toEqual([
        { callId: "call-1", kind: "tool-result", output: "done", toolName: "billing" },
      ]);
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
      {
        records: [
          createTaskRecord({
            child: LOCAL_CHILD,
            workflowCaller: { replyTo: "reply", runId: "run-1" },
          }),
        ],
      },
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

describe("ensureTaskCallbackAliasStep", () => {
  it("mints the callback alias once and keeps it on every later call", async () => {
    const minted = await ensureTaskCallbackAliasStep({ sessionState: ownerState([]) });

    expect(readTaskCallbackAlias(readDurableSession(minted.sessionState).state)).toMatch(
      /^eve:task-callback:[0-9a-f]{48}$/u,
    );
    await expect(ensureTaskCallbackAliasStep(minted)).resolves.toBe(minted);
  });
});

describe("cancelTasksStep", () => {
  it("cancels the turn's working tasks and signals the started children", async () => {
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
      selector: { kind: "active-turn" },
      serializedContext: {},
      sessionState: ownerState([started, starting, otherTurn, finished]),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    // A task cancelled before its child started still reports its outcome.
    expect(events).toEqual([
      {
        data: { callId: "call-1", status: "cancelled", taskId: started.id },
        type: "task.settled",
      },
      {
        data: { callId: "call-2", status: "cancelled", taskId: starting.id },
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

  it("cancels the turn's workflow tool calls through each run's control hook", async () => {
    const workflowCall = createTaskRecord({
      child: { commandToken: "control-hook", kind: "workflow", runId: "run-1" },
      id: "deploy-aaaaaa",
      kind: "workflow",
      name: "deploy",
    });

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "active-turn" },
      serializedContext: {},
      sessionState: ownerState([workflowCall]),
    });

    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "control-hook", runId: "run-1" },
      expect.any(String),
    );
    expect(events).toEqual([
      {
        data: { callId: "call-1", status: "cancelled", taskId: workflowCall.id },
        type: "task.settled",
      },
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
      selector: { kind: "active-turn" },
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
      selector: { kind: "active-turn" },
      serializedContext: {},
      sessionState: ownerState([working]),
    });
    const repeated = await cancelTasksStep({
      selector: { kind: "active-turn" },
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
        data: { callId: "call-1", status: "cancelled", taskId: working.id },
        type: "task.settled",
      },
    ]);
    expect(repeated.events).toEqual([]);
    expect(repeated.sessionState).toBe(cancelled.sessionState);
    expect(confirmed).toMatchObject({ events: [], replies: [], results: [] });
  });
});

function modelCall(
  input: { readonly agentId?: string; readonly message?: string; readonly target?: string } = {},
): AgentTaskCall {
  const target = input.target ?? "research";
  const callInput: { agentId?: string; message: string; target: string } = {
    message: input.message ?? "Find sources.",
    target,
  };
  if (input.agentId !== undefined) callInput.agentId = input.agentId;
  return { callId: "call-1", input: callInput, toolName: target };
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
