import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { ContinuationHookTokensKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { startSubagent } from "#execution/tools/subagent/start.js";
import {
  createWorkflowRuntime,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { getSessionTokenUsage } from "#harness/turn-tag-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import {
  applyTaskReport,
  cancelTasksStep,
  startAgentTasks,
  type AgentTaskCall,
} from "#tasks/owner.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable, ownerInboxHookToken } from "#tasks/state.js";
import { cancelTask } from "#tasks/table.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/coordination-dispatch-shared.js", () => ({ prepareActionDispatch: vi.fn() }));
vi.mock("#execution/tools/subagent/start.js", () => ({ startSubagent: vi.fn() }));
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
      }),
    );
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

    const update = await start([modelCall({ target: "billing" })]);

    const [record] = records(update.sessionState);
    expect(record?.child).toEqual({
      callbackBaseUrl: "https://parent.example",
      credentialResolver: "subagents/billing.ts",
      kind: "remote",
      sessionId: "remote-child",
      url: "https://billing.example",
    });
    expect(update.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: record?.id,
          callId: "call-1",
          childSessionId: "remote-child",
          name: "billing",
          remote: { resolverId: "subagents/billing.ts", url: "https://billing.example" },
          toolName: "billing",
          turnId: "turn-1",
        }),
        type: "subagent.called",
      }),
    ]);
    expect(update.results).toEqual([]);
    // Remote children call back on an unguessable alias, never the owner's stable inbox.
    const alias = readDurableSession(update.sessionState).state?.["eve.taskCallbackAlias"];
    expect(alias).toEqual(expect.stringMatching(/^task-callback:[0-9a-f]{48}$/u));
    expect(update.serializedContext[ContinuationHookTokensKey.name]).toEqual([alias]);
    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ parentContinuationToken: sessionInboxHookToken(alias as string) }),
    );
  });

  it("settles the record failed and returns the error when the child cannot start", async () => {
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
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({ callId: "call-1", status: "failed" }),
    ]);
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
    expect(startSubagent).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual([]);
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
      expect.objectContaining({
        data: expect.objectContaining({ agentId: idle.id, childSessionId: "child-session" }),
        type: "subagent.called",
      }),
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
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: record.id,
          callId: "call-1",
          childSessionId: "child-session",
          name: "research",
          turnId: "turn-1",
        }),
        type: "subagent.called",
      }),
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
          data: { callId: "call-1", output: "Found three sources.", subagentName: "research" },
          type: "subagent.completed",
        },
      ]);
      expect(update.replies).toEqual([]);
      const [settled] = records(update.sessionState);
      expect(settled).toMatchObject({
        delivered: true,
        lastStatus: "Found three sources.",
        status: "completed",
      });
      // A child whose session ended cannot be given more work.
      expect(settled?.child).toEqual(kind === "parked" ? LOCAL_CHILD : undefined);
      expect(getSessionTokenUsage(readDurableSession(update.sessionState))).toMatchObject({
        inputTokens: 2,
        outputTokens: 3,
      });
    },
  );

  it("returns a failed child result as an error without announcing completion", async () => {
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
    expect(update.events).toEqual([]);
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

    const { sessionState } = await cancelTasksStep({
      selector: { kind: "active-turn" },
      serializedContext: {},
      sessionState: ownerState([started, starting, otherTurn, finished]),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
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

    const { sessionState } = await cancelTasksStep({
      selector: { kind: "workflow-run", runId: "run-1" },
      serializedContext: {},
      sessionState: ownerState([ownTask, otherRun]),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
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
    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
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

async function start(calls: readonly AgentTaskCall[], existing: readonly TaskRecord[] = []) {
  return await startAgentTasks({
    callbackBaseUrl: "https://parent.example",
    calls,
    now: NOW,
    serializedContext: {},
    sessionState: ownerState(existing),
  });
}

function ownerState(existing: readonly TaskRecord[]): DurableSessionState {
  return createDurableSessionState({
    session: setHarnessEmissionState(
      {
        agent: { dynamicModel: true, system: "", tools: [] },
        compaction: { recentWindowSize: 5, threshold: 10_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent",
        state: existing.length === 0 ? undefined : taskTableState(existing),
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

function resultPayload(result: RuntimeSubagentChildResult) {
  return {
    kind: "runtime-action-result",
    results: [result],
  } satisfies RuntimeActionResultHookPayload;
}
