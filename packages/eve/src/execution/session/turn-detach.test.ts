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
import { DISMISSED_CALL_GRACE_MS, type TaskWaitPlan } from "#tasks/detach.js";
import { detachWaitedTasksStep } from "#tasks/detach-step.js";
import { answerTaskInput, endTaskWaits } from "#tasks/owner-body.js";
import type { TaskWaitRegistration } from "#tasks/wait.js";

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
}));
vi.mock("#execution/session-workflow-tool-run.js", () => ({
  handleWorkflowToolRunMessage: vi.fn(),
}));
vi.mock("#tasks/detach-step.js", () => ({ detachWaitedTasksStep: vi.fn() }));

// The foreground wait's rules (plan §4.8): a steering message that answers
// nothing detaches the waited calls of an interactive root turn, except
// attached ones, ends waited sleeps everywhere, and ends every `task_wait`;
// a `task_wait` timer ends only its own call; a result that lands first wins.

const STEERING: DeliverHookPayload = {
  kind: "deliver",
  payloads: [{ message: "Also check Plain." }],
};

const INTERACTIVE: TaskWaitPlan = { detachable: true, sleepCallIds: [], attachedCallIds: [] };

beforeEach(() => {
  vi.mocked(sleep).mockReset();
  vi.mocked(turnStep).mockReset();
  vi.mocked(dispatchCoordinationStep).mockReset();
  vi.mocked(detachWaitedTasksStep)
    .mockReset()
    .mockImplementation(async (input) => ({
      events: [],
      replies: [],
      results: [...input.endCallIds, ...input.detachCallIds]
        .filter((callId) => !input.keepTaskIds.includes(taskIdOf(callId)))
        .map((callId) => receipt(callId)),
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    }));
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

describe("detach on steer", () => {
  it("detaches every waited call and appends the message in the same step as the receipts", async () => {
    const { execution, steps } = setup({
      calls: ["call-d0", "call-sre"],
      script: [STEERING],
      wait: INTERACTIVE,
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        detachCallIds: ["call-d0", "call-sre"],
        endCallIds: [],
        keepTaskIds: [],
      }),
    );
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [receipt("call-d0"), receipt("call-sre")] },
    });
  });

  it("does not steer with a message that answered a pending question", async () => {
    vi.mocked(answerTaskInput).mockResolvedValueOnce({ kind: "continue", remainder: undefined });
    const { execution, steps } = setup({
      calls: ["call-refund"],
      script: [{ kind: "deliver", payloads: [{ message: "Yes" }] }, outcome("call-refund")],
      wait: INTERACTIVE,
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).not.toHaveBeenCalled();
    expect(steps()[1]).toEqual({
      delivery: undefined,
      runtimeResults: expect.objectContaining({ results: [result("call-refund")] }),
    });
  });

  it("keeps waiting on a call whose dismissible question the message dismissed", async () => {
    vi.mocked(sleep).mockImplementation(() => new Promise<void>(() => {}));
    dismissAsk();
    const { execution, steps } = setup({
      calls: ["call-ask", "call-d0"],
      script: [STEERING, outcome("call-ask")],
      wait: INTERACTIVE,
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        detachCallIds: ["call-ask", "call-d0"],
        keepTaskIds: [taskIdOf("call-ask")],
      }),
    );
    expect(sleep).toHaveBeenCalledExactlyOnceWith(DISMISSED_CALL_GRACE_MS);
    // The dismissed call resolves normally, alongside the other call's receipt.
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [result("call-ask"), receipt("call-d0")] },
    });
  });

  it("detaches a dismissed call into the message's group once its grace period ends", async () => {
    vi.mocked(sleep).mockResolvedValue(undefined);
    dismissAsk();
    const { execution, steps } = setup({
      calls: ["call-ask", "call-d0"],
      script: [STEERING, "timer"],
      wait: INTERACTIVE,
    });

    await execution.runTurn(undefined);

    expect(vi.mocked(detachWaitedTasksStep).mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ groupCallId: "call-ask", keepTaskIds: [taskIdOf("call-ask")] }),
      expect.objectContaining({
        detachCallIds: ["call-ask"],
        groupCallId: "call-ask",
        keepTaskIds: [],
      }),
    ]);
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [receipt("call-ask"), receipt("call-d0")] },
    });
  });

  it("keeps waiting under turnPolicy: queue and leaves the message for a later turn", async () => {
    const queued: DeliverHookPayload = { ...STEERING, turnPolicy: "queue" };
    const { execution, queue, steps } = setup({
      calls: ["call-d0"],
      script: [queued, outcome("call-d0")],
      wait: INTERACTIVE,
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).not.toHaveBeenCalled();
    expect(steps()[1]).toEqual({
      delivery: undefined,
      runtimeResults: expect.objectContaining({ results: [result("call-d0")] }),
    });
    expect(queue.pendingCount).toBe(1);
  });

  it("applies steering after the wait in a child or scheduled turn", async () => {
    const { execution, steps } = setup({
      calls: ["call-d0"],
      script: [STEERING, outcome("call-d0")],
      wait: { detachable: false, sleepCallIds: [], attachedCallIds: [] },
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).not.toHaveBeenCalled();
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [result("call-d0")] },
    });
  });

  it("ends a waited sleep in any session, and keeps waiting on the other calls", async () => {
    const { execution, steps } = setup({
      calls: ["call-sleep", "call-d0"],
      script: [STEERING, outcome("call-d0")],
      wait: { detachable: false, sleepCallIds: ["call-sleep"], attachedCallIds: [] },
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detachCallIds: [], endCallIds: ["call-sleep"] }),
    );
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [receipt("call-sleep"), result("call-d0")] },
    });
  });

  it("interrupts the wait once per steering message", async () => {
    vi.mocked(detachWaitedTasksStep).mockImplementation(async (input) => ({
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    }));
    const { execution } = setup({
      calls: ["call-d0"],
      script: [
        STEERING,
        { kind: "task.deadline", ownerRunId: "x", wakeAt: "y" },
        outcome("call-d0"),
      ],
      wait: INTERACTIVE,
    });
    await execution.runTurn(undefined);
    expect(detachWaitedTasksStep).toHaveBeenCalledTimes(1);
  });
});

describe("attached calls and task_wait", () => {
  it("never detaches an attached call on steer", async () => {
    const { execution, steps } = setup({
      calls: ["call-ask", "call-d0"],
      script: [STEERING, outcome("call-ask")],
      wait: { ...INTERACTIVE, attachedCallIds: ["call-ask"] },
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detachCallIds: ["call-d0"] }),
    );
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [result("call-ask"), receipt("call-d0")] },
    });
  });

  it("ends only the task_wait whose timer fired", async () => {
    vi.mocked(sleep).mockResolvedValue(undefined);
    const { execution, steps } = setup({
      calls: ["call-w1", "call-w2"],
      script: ["timer", outcome("call-w2")],
      taskWaits: [{ callId: "call-w1", timeoutMs: 5_000 }, { callId: "call-w2" }],
      wait: INTERACTIVE,
    });

    await execution.runTurn(undefined);

    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(endTaskWaits).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      callIds: ["call-w1"],
      reason: "timed_out",
    });
    expect(detachWaitedTasksStep).not.toHaveBeenCalled();
    expect(steps()[1]).toMatchObject({
      delivery: undefined,
      runtimeResults: {
        results: [expect.objectContaining({ callId: "call-w1" }), result("call-w2")],
      },
    });
  });

  it("ends every task_wait on steer and detaches only the other calls", async () => {
    vi.mocked(sleep).mockImplementation(() => new Promise<void>(() => {}));
    const { execution, steps } = setup({
      calls: ["call-w1", "call-w2", "call-d0"],
      script: [STEERING],
      taskWaits: [{ callId: "call-w1" }, { callId: "call-w2", timeoutMs: 60_000 }],
      wait: INTERACTIVE,
    });

    await execution.runTurn(undefined);

    expect(endTaskWaits).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      callIds: ["call-w1", "call-w2"],
      reason: "interrupted",
    });
    expect(detachWaitedTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detachCallIds: ["call-d0"] }),
    );
    expect(steps()[1]).toMatchObject({ delivery: STEERING });
  });

  it("lets a steering message end a task_wait outside an interactive root turn", async () => {
    const { execution, steps } = setup({
      calls: ["call-w1"],
      script: [STEERING],
      taskWaits: [{ callId: "call-w1" }],
      wait: { attachedCallIds: [], detachable: false, sleepCallIds: [] },
    });

    await execution.runTurn(undefined);

    expect(endTaskWaits).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      callIds: ["call-w1"],
      reason: "interrupted",
    });
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [expect.objectContaining({ callId: "call-w1" })] },
    });
  });
});

type ScriptItem = SessionInboxPayload | "timer";

/** The next routed message dismisses the dismissible question of `call-ask`. */
function dismissAsk(): void {
  vi.mocked(answerTaskInput).mockImplementationOnce(async (_cursor, delivery) => ({
    dismissedTaskIds: [taskIdOf("call-ask")],
    kind: "continue",
    remainder: delivery,
  }));
}

function setup(input: {
  readonly calls: readonly string[];
  readonly script: ScriptItem[];
  readonly taskWaits?: readonly TaskWaitRegistration[];
  readonly wait: TaskWaitPlan;
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
    wait: input.wait,
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
    mode: "conversation",
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

function receipt(callId: string): RuntimeToolResultActionResult {
  return {
    callId,
    kind: "tool-result",
    modelOutput: `receipt: ${taskIdOf(callId)}`,
    output: { status: "working", taskId: taskIdOf(callId) },
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
