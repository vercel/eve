import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type { InputRequest } from "#shared/input.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { answerTaskStep, publishTaskInputStep, surfaceTaskInputStep } from "#tasks/input-step.js";
import type { TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";
import { answerTask } from "#tasks/transport.js";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
  serializeContext: vi.fn(),
}));
vi.mock("#tasks/transport.js", () => ({ answerTask: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resumeHook: vi.fn(),
}));

const NOW = "2026-09-24T14:00:00.000Z";
const TASK_ID = "research-abc234";
const COORDINATES = { sequence: 4, stepIndex: 1, turnId: "child-turn" };
const STORED: TaskInputRequest = { kind: "question", requestId: "q-1" };
const QUESTION: InputRequest = {
  ...STORED,
  action: { callId: "tool-1", input: {}, kind: "tool-call", toolName: "pick_region" },
  prompt: "Which region?",
};

const turnAgent = {
  id: "test-agent",
  instructions: [],
  model: { id: "test-model" },
  tools: [],
  workspaceSpec: { rootEntries: [] },
};

let ctx: ContextContainer;
let chunks: Uint8Array[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  chunks = [];
  vi.mocked(serializeContext).mockImplementation((context) =>
    Object.fromEntries([...context.entries()].map(([key, value]) => [key.name, value])),
  );
});

function setup(adapter: ChannelAdapter = { kind: "test" }) {
  ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, {
    compiledArtifactsSource: { kind: "bundled" },
    graph: { root: { sandboxRegistry: { sandbox: null }, turnAgent } },
    hookRegistry: createEmptyHookRegistry(),
    resolvedAgent: { config: {} },
    turnAgent,
  } as never as CompiledBundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "http:owner");
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, "owner-session");
  vi.mocked(deserializeContext).mockResolvedValue(ctx);
}

function ownerState(records: readonly TaskRecord[]): DurableSessionState {
  const base = createTestSessionState({ continuationToken: "http:owner", sessionId: "owner" });
  const emission = { sequence: 3, sessionStarted: true, stepIndex: 2, turnId: "turn_3" };
  return {
    ...base,
    emissionState: emission,
    snapshot: {
      session: {
        ...base.snapshot.session,
        state: { ...taskTableState(records), "eve.harness.emission": emission },
      },
    },
  };
}

function writable() {
  return new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) });
}

function surface(sessionState: DurableSessionState, event: TaskInputEvent) {
  return surfaceTaskInputStep({
    event,
    serializedContext: {},
    sessionState,
    sessionWritable: writable(),
    taskId: TASK_ID,
  });
}

function published(): MessageStreamEvent[] {
  return chunks.map((chunk) => JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent);
}

function record(state: DurableSessionState): TaskRecord | undefined {
  return getTaskTable(state.snapshot.session).records[0];
}

function resolution(outcome: "answered" | "ignored") {
  return {
    data: {
      ...COORDINATES,
      resolutions: [
        outcome === "answered"
          ? {
              kind: "question" as const,
              outcome,
              requestId: "q-1",
              response: { requestId: "q-1", text: "eu" },
            }
          : { kind: "question" as const, outcome, requestId: "q-1" },
      ],
    },
    type: "input.resolved" as const,
  };
}

const waiting = (overrides: Partial<TaskRecord> = {}) =>
  createTaskRecord({
    child: { continuationToken: "child-token", kind: "local", sessionId: "child" },
    clockStoppedAt: NOW,
    deadlineAt: "2026-09-24T15:00:00.000Z",
    input: [{ ...COORDINATES, requests: [STORED] }],
    status: "input_required",
    ...overrides,
  });

describe("surfaceTaskInputStep", () => {
  it("surfaces a child's question with the task's ID, ends the turn's stream, and stops the clock", async () => {
    const seen: unknown[] = [];
    setup({
      kind: "test",
      "input.requested"(data, adapterCtx) {
        seen.push(data.taskId);
        adapterCtx.state.pending = data.requests.map((request) => request.requestId);
        adapterCtx.session.continuation?.alias("question-thread");
      },
    });
    const working = createTaskRecord({ deadlineAt: "2026-09-24T15:00:00.000Z" });
    const asked = {
      // A grandchild's ID from the child's stream is replaced by the owner's.
      data: { ...COORDINATES, requests: [{ ...QUESTION, dismissible: true }], taskId: "x-zzzzzz" },
      type: "input.requested" as const,
    };

    const result = await surface(ownerState([working]), asked);

    const events = published();
    expect(events.map((event) => event.type)).toEqual([
      "input.requested",
      "turn.completed",
      "session.waiting",
    ]);
    // `dismissible` stays on the owner's record; the stream carries the public shape.
    expect(events[0]).toMatchObject({
      data: { ...COORDINATES, requests: [QUESTION], taskId: TASK_ID },
    });
    expect(events[1]).toMatchObject({ data: { turnId: "turn_3" } });
    expect(seen).toEqual([TASK_ID]);
    expect(record(result.sessionState)).toMatchObject({
      clockStoppedAt: NOW,
      input: [{ ...COORDINATES, from: "x-zzzzzz", requests: [{ ...STORED, dismissible: true }] }],
      status: "input_required",
    });
    expect(ctx.require(ChannelKey).state).toEqual({ pending: ["q-1"] });
    expect(result.sessionState.continuationToken).toBe("http:question-thread");
    // Cancelling the turn now must not end its stream a second time.
    expect(result.sessionState.emissionState).toMatchObject({ endedByTaskInput: true, turnId: "" });
    expect(result.refused).toEqual([]);
  });

  it("leaves a turn a session-limit prompt ended open to the boundary its decline streams", async () => {
    setup();
    const limit = { ...QUESTION, kind: "session-limit" as const, requestId: "limit-1" };

    const result = await surface(ownerState([createTaskRecord()]), {
      data: { ...COORDINATES, requests: [limit] },
      type: "input.requested",
    });

    expect(published().map((event) => event.type)).toContain("session.waiting");
    expect(result.sessionState.emissionState.turnId).toBe("");
    expect(result.sessionState.emissionState).not.toHaveProperty("endedByTaskInput");
  });

  it("returns the requested IDs it refused because they are pending elsewhere", async () => {
    setup();
    const billing = waiting({ id: "billing-aaaaaa" });

    const result = await surface(ownerState([createTaskRecord(), billing]), {
      data: { ...COORDINATES, requests: [QUESTION] },
      type: "input.requested",
    });

    expect(result.refused).toEqual(["q-1"]);
    expect(published()).toEqual([]);
  });

  it("repeats a child's resolution and resumes the task's clock without ending a turn", async () => {
    setup();
    vi.setSystemTime(new Date("2026-09-24T14:10:00.000Z"));

    const result = await surface(ownerState([waiting()]), resolution("answered"));

    expect(published()).toEqual([expect.objectContaining(resolution("answered"))]);
    expect(record(result.sessionState)).toMatchObject({
      deadlineAt: "2026-09-24T15:10:00.000Z",
      status: "working",
    });
    expect(record(result.sessionState)).not.toHaveProperty("input");
  });

  it("publishes nothing for a resolution of requests its task does not wait on", async () => {
    setup();
    const state = ownerState([createTaskRecord()]);

    await expect(surface(state, resolution("answered"))).resolves.toEqual({
      refused: [],
      serializedContext: {},
      sessionState: state,
    });
    expect(published()).toEqual([]);
  });

  it("attributes sign-in and approval events to the task; only sign-in ends the turn's stream", async () => {
    setup();
    const state = ownerState([createTaskRecord()]);
    const required = {
      data: { description: "Sign in to Linear", name: "linear", ...COORDINATES, taskId: "x" },
      type: "authorization.required" as const,
    };
    const settled = {
      data: {
        outcome: "approved" as const,
        requestId: "a-1",
        responderPrincipalId: "u",
        ...COORDINATES,
      },
      type: "approval.settled" as const,
    };

    const afterSignIn = await surface(state, required);
    await surface(afterSignIn.sessionState, settled);

    const events = published();
    expect(events.map((event) => event.type)).toEqual([
      "authorization.required",
      "turn.completed",
      "session.waiting",
      "approval.settled",
    ]);
    expect(events[0]).toMatchObject({ data: { name: "linear", taskId: TASK_ID } });
    expect(events[3]).toMatchObject({ data: { requestId: "a-1", taskId: TASK_ID } });
    // Neither records a request: a sign-in does not stop the task's clock.
    expect(record(afterSignIn.sessionState)).not.toHaveProperty("input");
    // A cancel after a sign-in still streams its own boundary.
    expect(afterSignIn.sessionState.emissionState).not.toHaveProperty("endedByTaskInput");
  });
});

describe("publishTaskInputStep", () => {
  it("passes an intermediate agent's withdrawal on to its own caller", async () => {
    // Alice's research agent cancelled its billing task, which held a question.
    setup({
      kind: SUBAGENT_ADAPTER_KIND,
      state: {
        callId: "research-call",
        parentContinuationToken: "eve:inbox:v1:eve:session:root:inbox",
        parentSessionId: "root",
        subagentName: "research",
      },
    });
    const withdrawn = resolution("ignored");

    await publishTaskInputStep({
      events: [{ event: withdrawn, taskId: TASK_ID }],
      serializedContext: {},
      sessionState: ownerState([createTaskRecord({ status: "cancelled" })]),
      sessionWritable: writable(),
    });

    expect(published()).toEqual([expect.objectContaining(withdrawn)]);
    expect(resumeHook).toHaveBeenCalledExactlyOnceWith("eve:inbox:v1:eve:session:root:inbox", {
      callId: "research-call",
      childSessionId: "owner",
      event: withdrawn,
      kind: "task.input",
      subagentName: "research",
    });
  });
});

describe("answerTaskStep", () => {
  const delivery = { kind: "deliver" as const, payloads: [] };
  const answers = (task: TaskRecord) => ({
    deliveryMetadata: [],
    dismissed: [],
    record: task,
    responses: [{ requestId: "q-1", text: "eu" }],
  });
  const send = (task: TaskRecord) =>
    answerTaskStep({ answers: answers(task), delivery, serializedContext: {}, sessionId: "owner" });

  it("returns the resolutions of answers that reached the child, and publishes nothing", async () => {
    setup();
    vi.mocked(answerTask).mockResolvedValueOnce("delivered").mockResolvedValueOnce("retry");

    await expect(send(waiting())).resolves.toEqual([
      { event: resolution("answered"), taskId: TASK_ID },
    ]);
    // An answer that may yet arrive keeps its question answerable.
    await expect(send(waiting())).resolves.toEqual([]);
    expect(answerTask).toHaveBeenNthCalledWith(1, {
      answers: answers(waiting()),
      ctx,
      delivery,
      ownerSessionId: "owner",
    });
    expect(published()).toEqual([]);
  });

  it("resolves a question the owner answered, restarting its task's clock", async () => {
    setup();
    vi.setSystemTime(new Date("2026-09-24T14:10:00.000Z"));

    const result = await publishTaskInputStep({
      events: [{ event: resolution("answered"), taskId: TASK_ID }],
      serializedContext: {},
      sessionState: ownerState([waiting()]),
      sessionWritable: writable(),
    });

    expect(published()).toEqual([expect.objectContaining(resolution("answered"))]);
    expect(record(result.sessionState)).toMatchObject({
      deadlineAt: "2026-09-24T15:10:00.000Z",
      status: "working",
    });
  });
});
