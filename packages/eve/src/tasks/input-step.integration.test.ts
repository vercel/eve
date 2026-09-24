import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { answerTaskInputStep, surfaceTaskInputStep } from "#tasks/input-step.js";
import type { TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";
import { answerTask } from "#tasks/transport.js";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
  serializeContext: vi.fn(),
}));
vi.mock("#tasks/transport.js", () => ({ answerTask: vi.fn() }));

const NOW = "2026-09-24T14:00:00.000Z";
const TASK_ID = "research-abc234";
const COORDINATES = { sequence: 4, stepIndex: 1, turnId: "child-turn" };
const QUESTION: TaskInputRequest = {
  action: { callId: "tool-1", input: {}, kind: "tool-call", toolName: "pick_region" },
  kind: "question",
  prompt: "Which region?",
  requestId: "q-1",
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

function surface(sessionState: DurableSessionState, event: TaskInputEvent) {
  return surfaceTaskInputStep({
    event,
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream({ write: (chunk) => void chunks.push(chunk) }),
    taskId: TASK_ID,
  });
}

function published(): MessageStreamEvent[] {
  return chunks.map((chunk) => JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent);
}

function record(state: DurableSessionState): TaskRecord | undefined {
  return getTaskTable(state.snapshot.session).records[0];
}

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
      input: [{ ...COORDINATES, requests: [{ ...QUESTION, dismissible: true }] }],
      status: "input_required",
    });
    expect(ctx.require(ChannelKey).state).toEqual({ pending: ["q-1"] });
    expect(result.sessionState.continuationToken).toBe("http:question-thread");
    expect(result.sessionState.emissionState.turnId).toBe("");
  });

  it("repeats a child's resolution and resumes the task's clock without ending a turn", async () => {
    setup();
    const waiting = createTaskRecord({
      clockStoppedAt: NOW,
      deadlineAt: "2026-09-24T15:00:00.000Z",
      input: [{ ...COORDINATES, requests: [QUESTION] }],
      status: "input_required",
    });
    vi.setSystemTime(new Date("2026-09-24T14:10:00.000Z"));
    const resolution = {
      data: {
        ...COORDINATES,
        resolutions: [
          {
            kind: "question" as const,
            outcome: "answered" as const,
            requestId: "q-1",
            response: { requestId: "q-1", text: "eu" },
          },
        ],
      },
      type: "input.resolved" as const,
    };

    const result = await surface(ownerState([waiting]), resolution);

    expect(published()).toEqual([expect.objectContaining(resolution)]);
    expect(record(result.sessionState)).toMatchObject({
      deadlineAt: "2026-09-24T15:10:00.000Z",
      status: "working",
    });
    expect(record(result.sessionState)).not.toHaveProperty("input");
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
    // Neither records a request: a sign-in completes against the child directly.
    expect(record(afterSignIn.sessionState)).not.toHaveProperty("input");
  });
});

describe("answerTaskInputStep", () => {
  const delivery = { kind: "deliver" as const, payloads: [] };

  function answer(
    sessionState: DurableSessionState,
    records: readonly TaskRecord[],
    dismissed = false,
  ) {
    return answerTaskInputStep({
      answers: records.map((task) => ({
        deliveryMetadata: [],
        dismissed: dismissed ? ["q-1"] : [],
        record: task,
        responses: dismissed ? [] : [{ requestId: "q-1", text: "eu" }],
      })),
      delivery,
      serializedContext: {},
      sessionState,
      sessionWritable: new WritableStream({ write: (chunk) => void chunks.push(chunk) }),
    });
  }

  it("sends a child session its answers and leaves its requests until it resolves them", async () => {
    setup();
    const local = createTaskRecord({
      child: { continuationToken: "child-token", kind: "local", sessionId: "child" },
      input: [{ ...COORDINATES, requests: [QUESTION] }],
      status: "input_required",
    });

    await expect(answer(ownerState([local]), [local])).resolves.toEqual({});

    expect(answerTask).toHaveBeenCalledExactlyOnceWith({
      answers: expect.objectContaining({ record: local }),
      callbackAlias: undefined,
      ctx,
      delivery,
    });
    expect(published()).toEqual([]);
  });

  it.each([
    ["answered", false, { outcome: "answered", response: { requestId: "q-1", text: "eu" } }],
    ["dismissed", true, { outcome: "ignored" }],
  ])(
    "resolves a workflow run's %s question itself, at the question's coordinates",
    async (_label, dismissed, resolution) => {
      setup();
      const workflow = createTaskRecord({
        child: { commandToken: "control", kind: "workflow", runId: "run" },
        clockStoppedAt: NOW,
        input: [{ ...COORDINATES, requests: [{ ...QUESTION, dismissible: true }] }],
        kind: "workflow",
        status: "input_required",
      });

      const result = await answer(ownerState([workflow]), [workflow], dismissed);

      expect(answerTask).toHaveBeenCalledOnce();
      expect(published()).toEqual([
        expect.objectContaining({
          data: {
            ...COORDINATES,
            resolutions: [{ kind: "question", requestId: "q-1", ...resolution }],
          },
          type: "input.resolved",
        }),
      ]);
      expect(result.sessionState && record(result.sessionState)).toMatchObject({
        status: "working",
      });
    },
  );
});
