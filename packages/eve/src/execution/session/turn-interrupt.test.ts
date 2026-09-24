import { sleep } from "#compiled/@workflow/core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  InboxWaitEnded,
  type SessionInbox,
  type SessionInboxPayload,
} from "#execution/session-inbox/inbox.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { turnStep } from "#execution/session/turn-step.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { SessionExecution } from "#execution/session/turn.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { answerTaskInput, endTaskWaits, interruptAttachedCalls } from "#tasks/owner-body.js";
import type { TaskWaitRegistration } from "#tasks/wait.js";
import { DISMISSED_CALL_GRACE_MS } from "#tasks/wait-timers.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://owner.example", workflowRunId: "run-owner" }),
  sleep: vi.fn(),
}));
vi.mock("#execution/session/turn-step.js", () => ({ turnStep: vi.fn() }));
vi.mock("#execution/coordination-dispatch-step.js", () => ({ dispatchCoordinationStep: vi.fn() }));
vi.mock("#tasks/owner-body.js", async (importOriginal) => ({
  ...(await importOriginal()),
  answerTaskInput: vi.fn(),
  endTaskWaits: vi.fn(),
  interruptAttachedCalls: vi.fn(),
}));
vi.mock("#execution/session-workflow-tool-run.js", () => ({
  handleWorkflowToolRunMessage: vi.fn(),
}));

// The interrupt rule (plan §4.8), in every session: a steering message that
// answers nothing ends every attached call still in flight (`task_wait` and
// attached workflow tools) except calls whose question it dismissed, which
// get a grace period; a `task_wait` timer ends only its own call; a result
// that lands first wins. Detached calls already returned their receipts.

const STEERING: DeliverHookPayload = {
  kind: "deliver",
  payloads: [{ message: "Also check Plain." }],
};

beforeEach(() => {
  vi.mocked(sleep).mockReset();
  vi.mocked(turnStep).mockReset();
  vi.mocked(dispatchCoordinationStep).mockReset();
  vi.mocked(interruptAttachedCalls)
    .mockReset()
    .mockImplementation(async (_cursor, callIds) => callIds.map((callId) => stopped(callId)));
  vi.mocked(endTaskWaits)
    .mockReset()
    .mockImplementation(async (_cursor, input) =>
      (input.callIds ?? []).map((callId) => ({
        callId,
        kind: "tool-result",
        modelOutput: `${input.reason}: ${callId}`,
        output: { status: input.reason, taskId: taskIdOf(callId) },
        toolName: "task_wait",
      })),
    );
  vi.mocked(answerTaskInput)
    .mockReset()
    .mockImplementation(async (_cursor, delivery) => ({ kind: "continue", remainder: delivery }));
  vi.mocked(handleWorkflowToolRunMessage)
    .mockReset()
    .mockImplementation(async ({ message }) =>
      message.kind === "outcome" ? result(message.from.callId) : undefined,
    );
});

describe("the interrupt rule", () => {
  it("ends every attached call and appends the message in the same step as their results", async () => {
    const { execution, steps } = setup({
      calls: ["call-w1", "call-deploy"],
      script: [STEERING],
      taskWaits: [{ callId: "call-w1" }],
    });

    await execution.runTurn(undefined);

    expect(interruptAttachedCalls).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      "call-w1",
      "call-deploy",
    ]);
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [stopped("call-w1"), stopped("call-deploy")] },
    });
  });

  it("ends attached calls in a task-mode session too", async () => {
    const { execution, steps } = setup({
      calls: ["call-deploy"],
      mode: "task",
      script: [STEERING],
    });

    await execution.runTurn(undefined);

    expect(interruptAttachedCalls).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      "call-deploy",
    ]);
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [stopped("call-deploy")] },
    });
  });

  it("does not steer with a message that answered a pending question", async () => {
    vi.mocked(answerTaskInput).mockResolvedValueOnce({ kind: "continue", remainder: undefined });
    const { execution, steps } = setup({
      calls: ["call-refund"],
      script: [{ kind: "deliver", payloads: [{ message: "Yes" }] }, outcome("call-refund")],
    });

    await execution.runTurn(undefined);

    expect(interruptAttachedCalls).not.toHaveBeenCalled();
    expect(steps()[1]).toEqual({
      delivery: undefined,
      runtimeResults: expect.objectContaining({ results: [result("call-refund")] }),
    });
  });

  it("lets a call whose dismissible question the message dismissed resolve normally", async () => {
    vi.mocked(sleep).mockImplementation(() => new Promise<void>(() => {}));
    dismissAsk();
    const { execution, steps } = setup({
      calls: ["call-ask", "call-deploy"],
      script: [STEERING, outcome("call-ask")],
    });

    await execution.runTurn(undefined);

    expect(interruptAttachedCalls).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      "call-deploy",
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(DISMISSED_CALL_GRACE_MS);
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [result("call-ask"), stopped("call-deploy")] },
    });
  });

  it("stops a dismissed call once its grace period ends", async () => {
    vi.mocked(sleep).mockResolvedValue(undefined);
    dismissAsk();
    const { execution, steps } = setup({
      calls: ["call-ask", "call-deploy"],
      script: [STEERING, "timer"],
    });

    await execution.runTurn(undefined);

    expect(vi.mocked(interruptAttachedCalls).mock.calls.map(([, callIds]) => callIds)).toEqual([
      ["call-deploy"],
      ["call-ask"],
    ]);
    expect(endTaskWaits).not.toHaveBeenCalled();
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [stopped("call-ask"), stopped("call-deploy")] },
    });
  });

  it("keeps waiting under turnPolicy: queue and leaves the message for a later turn", async () => {
    const queued: DeliverHookPayload = { ...STEERING, turnPolicy: "queue" };
    const { execution, queue, steps } = setup({
      calls: ["call-deploy"],
      script: [queued, outcome("call-deploy")],
    });

    await execution.runTurn(undefined);

    expect(interruptAttachedCalls).not.toHaveBeenCalled();
    expect(steps()[1]).toEqual({
      delivery: undefined,
      runtimeResults: expect.objectContaining({ results: [result("call-deploy")] }),
    });
    expect(queue.pendingCount).toBe(1);
  });

  it("interrupts the wait once per steering message", async () => {
    vi.mocked(interruptAttachedCalls).mockResolvedValue([]);
    const { execution } = setup({
      calls: ["call-deploy"],
      script: [
        STEERING,
        { kind: "task.deadline", ownerRunId: "x", wakeAt: "y" },
        outcome("call-deploy"),
      ],
    });
    await execution.runTurn(undefined);
    expect(interruptAttachedCalls).toHaveBeenCalledTimes(1);
  });
});

describe("task_wait timeouts", () => {
  it("ends only the task_wait whose timer fired", async () => {
    vi.mocked(sleep).mockResolvedValue(undefined);
    const { execution, steps } = setup({
      calls: ["call-w1", "call-w2"],
      script: ["timer", outcome("call-w2")],
      taskWaits: [{ callId: "call-w1", timeoutMs: 5_000 }, { callId: "call-w2" }],
    });

    await execution.runTurn(undefined);

    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(endTaskWaits).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      callIds: ["call-w1"],
      reason: "timed_out",
    });
    expect(interruptAttachedCalls).not.toHaveBeenCalled();
    expect(steps()[1]).toMatchObject({
      delivery: undefined,
      runtimeResults: {
        results: [expect.objectContaining({ callId: "call-w1" }), result("call-w2")],
      },
    });
  });
});

type ScriptItem = SessionInboxPayload | "timer";

/** The next routed message dismisses the dismissible question of `call-ask`. */
function dismissAsk(): void {
  vi.mocked(answerTaskInput).mockImplementationOnce(async (_cursor, delivery) => ({
    dismissedCallIds: ["call-ask"],
    kind: "continue",
    remainder: delivery,
  }));
}

function setup(input: {
  readonly calls: readonly string[];
  readonly mode?: "conversation" | "task";
  readonly script: ScriptItem[];
  readonly taskWaits?: readonly TaskWaitRegistration[];
}) {
  const sessionState = ownerState();
  const queue = new SessionInputQueue();
  const script = [...input.script];
  const inbox: SessionInbox = {
    claimedTokens: [],
    claimSessionHook: vi.fn(),
    claimSessionHooks: vi.fn(),
    drain: () => [],
    hasPending: () => false,
    next: vi.fn(async (until?: Promise<unknown>) => {
      const item = script.shift();
      if (item === undefined) throw new Error("The scripted inbox has no more payloads.");
      if (item !== "timer") return item;
      if (until === undefined) throw new Error("No timer was armed.");
      return new InboxWaitEnded(await until);
    }) as SessionInbox["next"],
    onDelivery: () => () => {},
    onInterrupt: () => () => {},
    restore: vi.fn(),
  };
  const parked: DurableStepResult = {
    action: "park",
    hasPendingAuthorization: false,
    hasPendingInputBatch: false,
    pendingCoordinationCallIds: input.calls,
    serializedContext: {},
    sessionState,
  };
  vi.mocked(turnStep)
    .mockResolvedValueOnce(parked)
    .mockResolvedValueOnce({ action: "done", output: "ok", serializedContext: {}, sessionState });
  vi.mocked(dispatchCoordinationStep).mockResolvedValue({
    events: [],
    replies: [],
    results: [],
    serializedContext: {},
    sessionState,
    taskWaits: input.taskWaits,
  });
  const cursor = new SessionStateCursor({
    inbox,
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream<Uint8Array>(),
  });
  const execution = new SessionExecution({
    cursor,
    inbox,
    mode: input.mode ?? "conversation",
    queue,
    sessionId: sessionState.sessionId,
  });
  return {
    execution,
    queue,
    steps: () => vi.mocked(turnStep).mock.calls.map(([step]) => step.input),
  };
}

function taskIdOf(callId: string): string {
  return `${callId.replace("call-", "")}-a1b2c3`;
}

function stopped(callId: string): RuntimeToolResultActionResult {
  return {
    callId,
    kind: "tool-result",
    modelOutput: `stopped: ${callId}`,
    output: { status: "interrupted", waitedMs: 1_000 },
    toolName: "lookup",
  };
}

function result(callId: string): RuntimeToolResultActionResult {
  return { callId, kind: "tool-result", output: { found: callId }, toolName: "lookup" };
}

function outcome(callId: string): SessionInboxPayload {
  return {
    from: {
      callId,
      runId: `run-${callId}`,
      sequence: 0,
      stepIndex: 0,
      taskId: taskIdOf(callId),
      toolName: "lookup",
      turnId: "turn_1",
    },
    kind: "outcome",
    result: { output: { found: callId }, status: "completed" },
  };
}

function ownerState(): DurableSessionState {
  return createTestSessionState({
    emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn_1" },
    sessionId: "owner",
  });
}
