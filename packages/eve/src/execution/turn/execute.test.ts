import { admitSubmissions, splitSubmission } from "#execution/turn/submissions.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTurnStep, projectProgress } from "#execution/turn/execute.js";
import {
  createDurableSessionState,
  replaceDurableSessionSnapshot,
} from "#execution/session/state.js";
import { createSessionResources } from "#execution/session/resources.js";
import { recordWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type {
  AcceptedSubmission,
  InitializedSessionCheckpoint,
  PendingSubmission,
} from "#execution/turn/types.js";

const mocks = vi.hoisted(() => ({
  attempt: 2,
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
  timeout: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ stepId: "step", attempt: mocks.attempt }),
}));
vi.mock("#internal/workflow/background.js", () => ({ background: vi.fn() }));
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));
vi.mock("#execution/session/snapshots.js", () => ({
  sessionSnapshots: {
    latest: mocks.latest,
    append: mocks.append,
  },
}));
vi.mock("#execution/session/directory.js", () => ({ publishSessionDescriptor: mocks.publish }));
vi.mock("#execution/session/events.js", () => ({
  sessionEvents: {
    withWriter: async (
      _ref: unknown,
      run: (stream: WritableStream<Uint8Array>, signal: AbortSignal) => unknown,
    ) => run(new WritableStream(), new AbortController().signal),
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
vi.mock("#execution/turn/model.js", () => ({ runModel: mocks.model }));
vi.mock("#execution/turn/runtime-events.js", () => ({ applyRuntimeEvents: mocks.runtime }));
vi.mock("#subagents/parent-notification.js", () => ({
  bindTurnCallerContext: async (input: { serializedContext: unknown }) => input.serializedContext,
  resolveInitialTurnCaller: async () => undefined,
}));
vi.mock("#execution/session-timeout-steps.js", () => ({ startSessionTimeout: mocks.timeout }));

const session = createSessionResources("holder", "first");
const owner = { token: "inbox", ownerRunId: "candidate" };
const submission: AcceptedSubmission = {
  eventId: "next",
  command: { kind: "send", payload: { message: "Continue" } },
};
let checkpoint: InitializedSessionCheckpoint;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attempt = 2;
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
  mocks.latest.mockImplementation(async () => checkpoint);
  mocks.create.mockResolvedValue({ state });
  mocks.timeout.mockResolvedValue({ runId: "timer" });
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
  it("starts model work while bootstrap descriptor and timer operations are pending", async () => {
    const descriptor = Promise.withResolvers<void>();
    const timer = Promise.withResolvers<{ runId: string }>();
    mocks.latest.mockResolvedValue(null);
    mocks.publish.mockReturnValueOnce(descriptor.promise);
    mocks.timeout.mockReturnValueOnce(timer.promise);
    const running = run({
      submission: {
        ...submission,
        eventId: "first",
        initial: { serializedContext: { "eve.bundle": { source: {} } } },
      },
    });
    await vi.waitFor(() => expect(mocks.model).toHaveBeenCalledOnce());
    descriptor.resolve();
    timer.resolve({ runId: "timer" });
    expect(await running).toMatchObject({
      kind: "progress",
      progress: { checkpoint: { timeoutRunId: "timer" } },
    });
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it("hydrates once and performs no snapshot writes", async () => {
    await run();
    expect(mocks.latest).toHaveBeenCalledOnce();
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it("publishes bootstrap resources while the first owner holds admission", async () => {
    mocks.latest.mockResolvedValue(null);
    const result = await run({
      submission: {
        ...submission,
        eventId: "first",
        initial: { serializedContext: { "eve.bundle": { source: {} } }, sessionTimeoutMs: false },
      },
    });
    expect(mocks.publish.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.model.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({
      kind: "progress",
      progress: { checkpoint: { state: expect.anything(), serializedContext: expect.anything() } },
    });
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("uses the previous step result without any snapshot reads", async () => {
    const first = await run();
    if (first.kind !== "progress") throw new Error("Expected progress");
    mocks.latest.mockClear();
    await run({ checkpoint: first.progress.checkpoint });
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("retries interrupted work through normal Workflow step execution", async () => {
    mocks.model.mockRejectedValueOnce(new Error("Transient model failure"));
    await expect(run()).rejects.toThrow("Transient model failure");
    await run();
    expect(mocks.model).toHaveBeenCalledTimes(2);
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
    const result = await run({
      submission: { eventId: "cancel", command: { kind: "cancel", turnId: "old" } },
    });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(result.kind === "progress" ? result.progress.checkpoint : undefined).toMatchObject({
      deliveries: { cancel: "retired" },
      result: { action: "park" },
    });
  });

  it("returns executor ownership for acknowledgement after the step completes", async () => {
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
      session: recordWorkflowToolRun(checkpoint.state.snapshot.session, tool),
    });
    mocks.dispatch.mockResolvedValue({
      sessionState: dispatchedState,
      results: [],
    });
    const result = await run({ checkpoint, work: { kind: "dispatch" } });
    expect(result.kind === "progress" ? result.progress.checkpoint : undefined).toMatchObject({
      pendingToolAcks: [tool],
    });
    expect(mocks.acknowledgeTools).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
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
    const result = await run({
      checkpoint,
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
    const updated = result.kind === "progress" ? result.progress.checkpoint : undefined;
    expect(updated).toMatchObject({
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
      updated?.queue[0]?.submission.command.kind === "send"
        ? updated.queue[0].submission.command.payload.inputResponses
        : undefined,
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
    expect(projectProgress(checkpoint).action).toBe("wait");
    checkpoint = {
      ...checkpoint,
      inputs: [
        pending({
          kind: "send",
          payload: { inputResponses: [{ requestId: "question", text: "Yes" }] },
        }),
      ],
    };
    expect(projectProgress(checkpoint).action).toBe("continue");
  });
  it("does not infer alias ownership from the session's current token", () => {
    expect(projectProgress(checkpoint)).toMatchObject({
      continuationToken: "alias",
      claimedContinuationToken: undefined,
    });
  });
  it("keeps the acknowledged alias separate from a new unclaimed continuation", () => {
    checkpoint = { ...checkpoint, claimedContinuationToken: "previous-alias" };
    expect(projectProgress(checkpoint)).toMatchObject({
      continuationToken: "alias",
      claimedContinuationToken: "previous-alias",
    });
  });
  it.each([
    ["cancelled", "cancelled"],
    ["done", "settle"],
  ] as const)("settles %s before consuming remaining inputs", (action, expected) => {
    checkpoint = {
      ...checkpoint,
      inputs: [pending({ kind: "send", payload: { message: "Arrived during execution" } })],
      result: {
        action,
        sessionState: checkpoint.state,
        serializedContext: {},
      },
    };
    expect(projectProgress(checkpoint).action).toBe(expected);
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
    expect(projectProgress(checkpoint).action).toBe("wait");
  });
});
