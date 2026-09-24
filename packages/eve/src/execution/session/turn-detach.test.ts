import { sleep } from "#compiled/@workflow/core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
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

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://owner.example", workflowRunId: "run-owner" }),
  sleep: vi.fn(),
}));
vi.mock("#execution/session/turn-step.js", () => ({ turnStep: vi.fn() }));
vi.mock("#execution/coordination-dispatch-step.js", () => ({ dispatchCoordinationStep: vi.fn() }));
vi.mock("#execution/route-child-delivery.js", () => ({ routeDeliverToChildren: vi.fn() }));
vi.mock("#execution/session-workflow-tool-run.js", () => ({
  handleWorkflowToolRunMessage: vi.fn(),
}));
vi.mock("#tasks/detach-step.js", () => ({ detachWaitedTasksStep: vi.fn() }));

// The foreground wait's detach rules (plan §4.8): a steering message that
// answers nothing detaches the waited calls of an interactive root turn and
// ends waited sleeps everywhere; a `detach: { timeout }` timer detaches only
// its own call; a result that lands first wins.

const STEERING: DeliverHookPayload = {
  kind: "deliver",
  payloads: [{ message: "Also check Plain." }],
};

const INTERACTIVE: TaskWaitPlan = { detachable: true, sleepCallIds: [], timeouts: [] };

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
        .map((callId) => receipt(callId, input.reason)),
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    }));
  vi.mocked(routeDeliverToChildren)
    .mockReset()
    .mockImplementation(async ({ delivery, serializedContext, sessionState }) => ({
      kind: "continue",
      remainder: delivery,
      serializedContext,
      sessionState,
    }));
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
        reason: "steer",
      }),
    );
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [receipt("call-d0", "steer"), receipt("call-sre", "steer")] },
    });
  });

  it("does not steer with a message that answered a pending question", async () => {
    vi.mocked(routeDeliverToChildren).mockImplementationOnce(
      async ({ serializedContext, sessionState }) => ({
        kind: "continue",
        remainder: undefined,
        serializedContext,
        sessionState,
      }),
    );
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
      runtimeResults: { results: [result("call-ask"), receipt("call-d0", "steer")] },
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
        reason: "steer",
      }),
    ]);
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [receipt("call-ask", "steer"), receipt("call-d0", "steer")] },
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
      wait: { detachable: false, sleepCallIds: [], timeouts: [] },
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
      wait: { detachable: false, sleepCallIds: ["call-sleep"], timeouts: [] },
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detachCallIds: [], endCallIds: ["call-sleep"], reason: "steer" }),
    );
    expect(steps()[1]).toMatchObject({
      delivery: STEERING,
      runtimeResults: { results: [receipt("call-sleep", "steer"), result("call-d0")] },
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

describe("detach: { timeout }", () => {
  const TIMED: TaskWaitPlan = {
    detachable: true,
    sleepCallIds: [],
    timeouts: [{ callId: "call-slow", timeoutMs: 120_000 }],
  };

  it("detaches only the slow call when its timer fires first", async () => {
    vi.mocked(sleep).mockResolvedValue(undefined);
    const { execution, steps } = setup({
      calls: ["call-fast", "call-slow"],
      script: [outcome("call-fast"), "timer"],
      wait: TIMED,
    });

    await execution.runTurn(undefined);

    expect(sleep).toHaveBeenCalledExactlyOnceWith(120_000);
    expect(detachWaitedTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detachCallIds: ["call-slow"], keepTaskIds: [], reason: "timeout" }),
    );
    expect(steps()[1]).toMatchObject({
      delivery: undefined,
      runtimeResults: { results: [result("call-fast"), receipt("call-slow", "timeout")] },
    });
  });

  it("lets a result that landed first win over a timer that already fired", async () => {
    vi.mocked(sleep).mockResolvedValue(undefined);
    const { execution, steps } = setup({
      calls: ["call-slow"],
      // The inbox hands out an accepted payload before reporting the timer.
      script: [outcome("call-slow")],
      wait: TIMED,
    });

    await execution.runTurn(undefined);

    expect(detachWaitedTasksStep).not.toHaveBeenCalled();
    expect(steps()[1]).toMatchObject({ runtimeResults: { results: [result("call-slow")] } });
  });

  it("runs no timer outside an interactive root turn", async () => {
    const { execution } = setup({
      calls: ["call-slow"],
      script: [outcome("call-slow")],
      wait: { ...TIMED, detachable: false },
    });
    await execution.runTurn(undefined);
    expect(sleep).not.toHaveBeenCalled();
  });
});

type ScriptItem = SessionInboxPayload | "timer";

/** The next routed message dismisses the dismissible question of `call-ask`. */
function dismissAsk(): void {
  vi.mocked(routeDeliverToChildren).mockImplementationOnce(
    async ({ delivery, serializedContext, sessionState }) => ({
      dismissedTaskIds: [taskIdOf("call-ask")],
      kind: "continue",
      remainder: delivery,
      serializedContext,
      sessionState,
    }),
  );
}

function setup(input: {
  readonly calls: readonly string[];
  readonly script: ScriptItem[];
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

function receipt(callId: string, reason: "steer" | "timeout"): RuntimeToolResultActionResult {
  return {
    callId,
    kind: "tool-result",
    modelOutput: `${reason}: ${taskIdOf(callId)}`,
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
