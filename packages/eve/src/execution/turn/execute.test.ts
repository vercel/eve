import { admitSubmissions, splitSubmission } from "#execution/turn/submissions.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTurnStep, projectProgress } from "#execution/turn/execute.js";
import {
  createDurableSessionState,
  replaceDurableSessionSnapshot,
} from "#execution/session/state.js";
import { createSessionResources, type SnapshotRecordRef } from "#execution/session/resources.js";
import { recordWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type {
  AcceptedSubmission,
  InitializedSessionCheckpoint,
  PendingSubmission,
} from "#execution/turn/types.js";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  read: vi.fn(),
  latest: vi.fn(),
  append: vi.fn(),
  publish: vi.fn(),
  model: vi.fn(),
  runtime: vi.fn(),
  route: vi.fn(),
  dispatch: vi.fn(),
  acknowledge: vi.fn(),
  acknowledgeTools: vi.fn(),
  create: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ stepId: "step" }),
}));
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn() }));
vi.mock("#execution/session/snapshots.js", () => ({
  sessionSnapshots: {
    find: mocks.find,
    read: mocks.read,
    latest: mocks.latest,
    append: mocks.append,
  },
}));
vi.mock("#execution/session/directory.js", () => ({ publishSessionDescriptor: mocks.publish }));
vi.mock("#execution/session/events.js", () => ({
  sessionEvents: {
    withWriter: async (_ref: unknown, run: (stream: WritableStream<Uint8Array>) => unknown) =>
      run(new WritableStream()),
  },
}));
vi.mock("#execution/session/create-state.js", () => ({ createSessionState: mocks.create }));
vi.mock("#execution/turn/dispatch-coordination.js", () => ({
  dispatchCoordination: mocks.dispatch,
}));
vi.mock("#execution/tasks/dispatch.js", () => ({ acknowledgeDelegatedTasks: mocks.acknowledge }));
vi.mock("#execution/workflow-tool/start.js", () => ({
  acknowledgeWorkflowTools: mocks.acknowledgeTools,
}));
vi.mock("#execution/route-child-delivery.js", () => ({ routeDeliverToChildren: mocks.route }));
vi.mock("#execution/turn/model.js", () => ({ runModelStep: mocks.model }));
vi.mock("#execution/turn/runtime-events.js", () => ({ applyRuntimeEvents: mocks.runtime }));
vi.mock("#subagents/parent-notification.js", () => ({
  bindTurnCallerContext: async (input: { serializedContext: unknown }) => input.serializedContext,
  resolveInitialTurnCaller: async () => undefined,
}));
vi.mock("#execution/session-timeout-steps.js", () => ({ startSessionTimeout: vi.fn() }));

const session = createSessionResources("holder", "first");
const ref = { id: "checkpoint" } as SnapshotRecordRef;
const owner = { token: "inbox", ownerRunId: "candidate" };
const submission: AcceptedSubmission = {
  eventId: "next",
  command: { kind: "send", payload: { message: "Continue" } },
};
let checkpoint: InitializedSessionCheckpoint;

beforeEach(() => {
  vi.clearAllMocks();
  const state = createDurableSessionState({
    session: {
      sessionId: session.sessionId,
      continuationToken: "alias",
      history: [],
      agent: { modelReference: { id: "model" }, system: "", tools: [] },
      compaction: { threshold: 1000, recentWindowSize: 10 },
    },
  });
  checkpoint = {
    writeId: "before",
    writerRunId: "previous",
    phase: "settled",
    state,
    serializedContext: {},
    deliveries: {},
    queue: [],
  };
  mocks.find.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async () => checkpoint);
  mocks.latest.mockImplementation(async () => ({ ref, checkpoint }));
  mocks.append.mockResolvedValue(ref);
  mocks.create.mockResolvedValue({ state });
  mocks.model.mockImplementation(async (input) => ({
    action: "continue",
    sessionState: input.sessionState,
    serializedContext: input.serializedContext,
  }));
  mocks.route.mockImplementation(async (input) => ({
    kind: "continue",
    remainder: input.delivery,
    sessionState: input.sessionState,
    serializedContext: input.serializedContext,
  }));
  mocks.runtime.mockImplementation(async (input) => ({
    state: input.state,
    serializedContext: input.serializedContext,
    results: [],
    acceptedAtMsByCallId: {},
  }));
});

const run = (changes: Partial<Parameters<typeof executeTurnStep>[0]> = {}) =>
  executeTurnStep({
    session,
    owner,
    submission,
    work: { kind: "model" },
    abortSignal: new AbortController().signal,
    ...changes,
  });

describe("turn execution boundary", () => {
  it("publishes bootstrap readiness after its first durable checkpoint and before model effects", async () => {
    mocks.latest.mockResolvedValue(undefined);
    const result = await run({
      submission: {
        ...submission,
        eventId: "first",
        initial: { serializedContext: { "eve.bundle": { source: {} } }, sessionTimeoutMs: false },
      },
    });
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]!,
    );
    expect(mocks.publish.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.model.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ kind: "progress", progress: { checkpoint: ref } });
    expect(JSON.stringify(result)).not.toContain("serializedContext");
    expect(JSON.stringify(result)).not.toContain("history");
  });

  it("does not replay model effects after a committed attempt, but retries its durable task acknowledgment", async () => {
    const task = { taskId: "task", taskRunId: "run", taskInboxToken: "task-inbox" };
    mocks.find.mockResolvedValueOnce({
      ref,
      checkpoint: { ...checkpoint, pendingTaskAcks: [task], result: { action: "continue" } },
    });
    await run();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.acknowledge).toHaveBeenCalledWith({ tasks: [task] });
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("fails a previously entered attempt without repeating uncertain effects", async () => {
    mocks.find.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ref, checkpoint });
    await expect(run()).rejects.toThrow("did not commit");
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("keeps a pending earlier candidate in front without touching session effects", async () => {
    checkpoint = {
      ...checkpoint,
      queue: [{ submission: { ...submission, eventId: "earlier" }, candidateRunId: "earlier-run" }],
    };
    expect(await run()).toEqual({ kind: "wait", runId: "earlier-run" });
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("does not turn a storage failure into an empty session", async () => {
    mocks.latest.mockRejectedValue(new Error("storage unavailable"));
    await expect(run()).rejects.toThrow("storage unavailable");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("retires a cancel that acquires idle ownership without inventing a model turn", async () => {
    await run({ submission: { eventId: "cancel", command: { kind: "cancel", turnId: "old" } } });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.append.mock.lastCall?.[1]).toMatchObject({
      deliveries: { cancel: "retired" },
      result: { action: "park" },
    });
  });

  it("commits executor ownership before acknowledging tasks and blocking tools", async () => {
    const task = { taskId: "task", taskRunId: "run", taskInboxToken: "task-inbox" };
    checkpoint = {
      ...checkpoint,
      phase: "running",
      writerRunId: owner.ownerRunId,
      result: {
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call"],
        sessionState: checkpoint.state,
        serializedContext: {},
      },
    };
    const tool = { callId: "call", hookToken: "tool-inbox", runId: "tool-run", toolName: "tool" };
    const dispatchedState = replaceDurableSessionSnapshot({
      state: checkpoint.state,
      session: recordWorkflowToolRun(checkpoint.state.snapshot.session, tool),
    });
    mocks.dispatch.mockResolvedValue({
      sessionState: dispatchedState,
      results: [],
      pendingTasks: [task],
    });
    await run({ checkpoint: ref, work: { kind: "dispatch" } });
    expect(mocks.append.mock.lastCall?.[1]).toMatchObject({
      pendingTaskAcks: [task],
      pendingToolAcks: [tool],
    });
    expect(mocks.acknowledgeTools).toHaveBeenCalledWith({ runs: [tool] });
    expect(mocks.append.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.acknowledgeTools.mock.invocationCallOrder[0]!,
    );
    expect(mocks.append.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.acknowledge.mock.invocationCallOrder[0]!,
    );
  });

  it("routes answers to a waiting child without running the model or losing queued messages", async () => {
    checkpoint = {
      ...checkpoint,
      phase: "running",
      writerRunId: owner.ownerRunId,
      inputs: [],
      result: {
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call"],
        sessionState: checkpoint.state,
        serializedContext: {},
      },
      dispatched: true,
    };
    mocks.route.mockImplementation(async (input) => ({
      kind: "continue",
      remainder: undefined,
      sessionState: input.sessionState,
      serializedContext: input.serializedContext,
    }));
    const mixed = {
      ...submission,
      command: {
        kind: "send" as const,
        turnPolicy: "queue" as const,
        payload: { message: "Later", inputResponses: [{ requestId: "question", text: "Yes" }] },
      },
    };
    await run({
      checkpoint: ref,
      work: {
        kind: "events",
        envelopes: [
          {
            kind: "session.submit",
            eventId: mixed.eventId,
            payload: { submission: mixed, candidateRunId: "waiting" },
          },
        ],
      },
    });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.route).toHaveBeenCalledOnce();
    expect(mocks.append.mock.lastCall?.[1]).toMatchObject({
      deliveries: { "next:response": "applied" },
      inputs: [],
      queue: [
        {
          candidateRunId: "waiting",
          submission: { eventId: "next", command: { payload: { message: "Later" } } },
        },
      ],
    });
    expect(
      mocks.append.mock.lastCall?.[1].queue[0].submission.command.payload.inputResponses,
    ).toBeUndefined();
  });
});

describe("admission and progress", () => {
  const pending = (command: AcceptedSubmission["command"]): PendingSubmission => ({
    candidateRunId: "other",
    submission: { eventId: "incoming", command },
  });
  it("queues a new invocation caller instead of dropping its reply target into an unrelated turn", () => {
    const caller = {
      callId: "child-call",
      subagentName: "child",
      replyTo: { kind: "session" as const, token: "parent" },
    };
    const input = pending({ kind: "send", payload: { message: "Work" }, caller });
    expect(admitSubmissions(checkpoint, [input])).toMatchObject({ inputs: [], queue: [input] });
  });
  it("keeps mixed answers separate from the queued message's delivery identity", () => {
    const input = pending({
      kind: "send",
      turnPolicy: "queue",
      payload: { message: "Later", inputResponses: [{ requestId: "question", text: "Yes" }] },
    });
    const split = splitSubmission(input);
    expect(split.map((item) => item.submission.eventId)).toEqual(["incoming:response", "incoming"]);
    expect(split.every((item) => item.candidateRunId === input.candidateRunId)).toBe(true);
  });
  it("keeps task-mode human input waits owned until a response can resume the model", () => {
    checkpoint = {
      ...checkpoint,
      result: {
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: true,
        sessionState: checkpoint.state,
        serializedContext: {},
      },
    };
    expect(projectProgress(ref, checkpoint).action).toBe("wait");
    checkpoint = {
      ...checkpoint,
      inputs: [
        pending({
          kind: "send",
          payload: { inputResponses: [{ requestId: "question", text: "Yes" }] },
        }),
      ],
    };
    expect(projectProgress(ref, checkpoint).action).toBe("continue");
  });
  it("does not infer alias ownership from the session's current token", () => {
    expect(projectProgress(ref, checkpoint)).toMatchObject({
      continuationToken: "alias",
      claimedContinuationToken: undefined,
    });
  });
  it("keeps the acknowledged alias separate from a new unclaimed continuation", () => {
    checkpoint = { ...checkpoint, claimedContinuationToken: "previous-alias" };
    expect(projectProgress(ref, checkpoint)).toMatchObject({
      continuationToken: "alias",
      claimedContinuationToken: "previous-alias",
    });
  });
  it("does not resume a blocking batch after only one result", () => {
    checkpoint = {
      ...checkpoint,
      dispatched: true,
      result: {
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["one", "two"],
        sessionState: checkpoint.state,
        serializedContext: {},
      },
      runtimeResults: [{ kind: "tool-result", callId: "one", toolName: "tool", output: "done" }],
    };
    expect(projectProgress(ref, checkpoint).action).toBe("wait");
  });
});
