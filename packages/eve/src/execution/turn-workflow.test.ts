import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookPayload } from "#channel/types.js";
import { SessionDynamicModelReferenceKey } from "#context/keys.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { releaseAgentInvocationOwnerStep } from "#execution/tools/subagent/invoke-step.js";
import { cancelAgentInvocationOwnerStep } from "#execution/tools/subagent/task-cancel.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import { turnWorkflow } from "#execution/turn-workflow.js";
import {
  TURN_WORKFLOW_INPUT_VERSION,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { turnStep } from "#execution/workflow-steps.js";
import { AGENT_HANDLES_STATE_KEY } from "#subagents/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import { recordWorkflowToolRun } from "#harness/workflow-tool-runs.js";

const resumeHookMock = vi.fn();
const createHookMock = vi.fn();
const definedHookPayloads = new Map<string, readonly unknown[]>();

function createDefinedHookMock(token: string, values: readonly unknown[]): unknown {
  const queue = [...values];
  return {
    token,
    getConflict: vi.fn(async () => null),
    dispose: vi.fn(),
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: vi.fn(async () => {
          const value = queue.shift();
          return value === undefined ? await new Promise<never>(() => {}) : { done: false, value };
        }),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      };
    },
  };
}

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  defineHook: () => ({
    create: (options?: { readonly token?: string }) => {
      const token = options?.token ?? "hook";
      return createDefinedHookMock(token, definedHookPayloads.get(token) ?? []);
    },
    resume: async () => null,
  }),
  getWorkflowMetadata: vi.fn(() => ({ url: "https://eve.example.com" })),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

vi.mock("../subagents/event-proxy-step.js", () => ({
  runProxySubagentEventStep: vi.fn(),
}));

vi.mock("./workflow-steps.js", () => ({
  turnStep: vi.fn(),
}));

vi.mock("#execution/coordination-dispatch-step.js", () => ({
  dispatchCoordinationStep: vi.fn(),
}));

vi.mock("./cancel-descendant-turns-step.js", () => ({
  cancelDescendantTurnsStep: vi.fn(),
}));

vi.mock("./tasks/parent/delegate.js", () => ({
  acknowledgeDelegatedTasksStep: vi.fn(),
}));

vi.mock("./tools/subagent/task-agent-requests.js", () => ({
  applyTaskAgentRequest: vi.fn(),
}));

vi.mock("./tools/subagent/invoke-step.js", () => ({
  releaseAgentInvocationOwnerStep: vi.fn(),
}));

vi.mock("./tools/subagent/task-cancel.js", () => ({
  cancelAgentInvocationOwnerStep: vi.fn(),
}));

vi.mock("./workflow-callback-url.js", () => ({
  resolveWorkflowCallbackBaseUrl: vi.fn((metadataUrl: string) => metadataUrl),
}));

describe("turnWorkflow", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resumeHookMock.mockReset();
    createHookMock.mockReset();
    vi.mocked(applyTaskAgentRequest).mockReset();
    vi.mocked(releaseAgentInvocationOwnerStep).mockReset();
    vi.mocked(cancelAgentInvocationOwnerStep).mockReset();
    definedHookPayloads.clear();
  });

  it("notifies the driver when a turn completes", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input, parentWritable } = createInput({ sessionState });
    await turnWorkflow(input);

    expect(turnStep).toHaveBeenCalledWith({
      input: input.stepInput.input,
      parentWritable,
      serializedContext: input.stepInput.serializedContext,
      sessionState,
    });
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        kind: "done",
        output: "ok",
        serializedContext: { state: "done" },
        sessionState,
      },
      kind: "turn-result",
    });
  });

  it("continues from an inline step result without executing it twice", async () => {
    const initialState = createSessionState();
    const finalState = createSessionState({ continuationToken: "http:continued" });
    installInbox([]);
    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      sessionState: initialState,
    });

    await turnWorkflow({
      ...input,
      initialStep: {
        beforeStep: {
          serializedContext: input.stepInput.serializedContext,
          sessionState: initialState,
        },
        result: {
          action: "done",
          output: "already complete",
          serializedContext: { state: "done" },
          sessionState: finalState,
        },
      },
    });

    expect(turnStep).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({ kind: "done", output: "already complete" }),
        kind: "turn-result",
      }),
    );
  });

  it("keeps earlier inline state when cancellation wins over a completed step", async () => {
    const initialState = createSessionState({ continuationToken: "http:initial" });
    const beforeStepState = createSessionState({ continuationToken: "http:inline-checkpoint" });
    const completedState = createSessionState({ continuationToken: "http:completed" });
    installInbox([]);
    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      sessionState: initialState,
    });

    await turnWorkflow({
      ...input,
      initialCancellation: {},
      initialStep: {
        beforeStep: {
          serializedContext: { state: "inline-checkpoint" },
          sessionState: beforeStepState,
        },
        result: {
          action: "done",
          output: "must not complete",
          serializedContext: { state: "done" },
          sessionState: completedState,
        },
      },
    });

    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
      serializedContext: { state: "inline-checkpoint" },
      sessionState: beforeStepState,
    });
    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({
          cancelled: true,
          kind: "park",
          sessionState: beforeStepState,
        }),
        kind: "turn-result",
      }),
    );
  });

  it("migrates a pre-version (unversioned) input and runs the first turn step", async () => {
    const sessionState = createSessionState();
    const parentWritable = new WritableStream<Uint8Array>();
    const delivery = {
      kind: "deliver",
      payloads: [{ message: "hello" }],
    } satisfies HookPayload;
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    await turnWorkflow({
      capabilities: undefined,
      completionToken: "turn-token",
      delivery,
      mode: "conversation",
      parentWritable,
      serializedContext: { state: "start" },
      sessionState,
    });

    expect(turnStep).toHaveBeenCalledWith({
      input: delivery,
      parentWritable,
      serializedContext: { state: "start" },
      sessionState,
    });
    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({ kind: "turn-result" }),
    );
  });

  it("keeps tool-loop continuations inside the same turn workflow", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "continue",
        serializedContext: { state: "continued" },
        sessionState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "after continue",
        serializedContext: { state: "done" },
        sessionState,
      });

    const { input } = createInput({ sessionState });
    await turnWorkflow(input);

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].input).toBe(input.stepInput.input);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toBeUndefined();
    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({ kind: "done", output: "after continue" }),
        kind: "turn-result",
      }),
    );
  });

  it("parks when an authorization is pending", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: true,
      hasPendingInputBatch: false,
      serializedContext: { state: "needs-auth" },
      sessionState,
    });

    const { input } = createInput({
      mode: "task",
      sessionState,
    });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({
          kind: "park",
          sessionState,
        }),
        kind: "turn-result",
      }),
    );
  });

  it("dispatches runtime actions when a runtime action batch is pending", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      pendingCoordinationCallIds: ["call-1"],
      serializedContext: { state: "pending-runtime-action" },
      sessionState,
    });

    const { input } = createInput({ mode: "task", sessionState });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        kind: "dispatch-coordination",
        pendingCallIds: ["call-1"],
        serializedContext: { state: "pending-runtime-action" },
        sessionState,
      },
      kind: "turn-result",
    });
  });

  it("parks for pending input when the channel supports input requests", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: true,
      serializedContext: { state: "pending-input" },
      sessionState,
    });

    const { input } = createInput({
      capabilities: { requestInput: true },
      mode: "task",
      sessionState,
    });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({
          kind: "park",
          serializedContext: { state: "pending-input" },
        }),
        kind: "turn-result",
      }),
    );
  });

  it("reports task-mode waits as turn errors", async () => {
    const sessionState = createSessionState();
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      serializedContext: { state: "task-wait" },
      sessionState,
    });

    const { input } = createInput({ mode: "task", sessionState });
    await expect(turnWorkflow(input)).rejects.toThrow();

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock.mock.calls[0]?.[0]).toBe("turn-token");
    expect(resumeHookMock.mock.calls[0]?.[1]).toMatchObject({
      kind: "turn-error",
    });
  });

  it("reports a cancelled turn as a park with the cancelled marker", async () => {
    const sessionState = createSessionState();
    const cancelledState = createSessionState({ continuationToken: "cancelled-state" });
    installInbox([]);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "cancelled",
      serializedContext: { state: "cancelled" },
      sessionState: cancelledState,
    });

    // Task mode on purpose: cancellation bypasses the `canPark` gate.
    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      mode: "task",
      sessionState,
    });
    await turnWorkflow(input);

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
      serializedContext: { state: "cancelled" },
      sessionState: cancelledState,
    });
    // The command inbox forwards cancellation to this turn-private hook.
    expect(cancelHookTokens()).toEqual(["turn-token:cancel"]);
    // The cancelled step has already rolled its context back to the allowed
    // carve-outs, which must reach the driver cancellation epilogue.
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        cancelled: true,
        kind: "park",
        serializedContext: { state: "cancelled" },
        sessionState: cancelledState,
      },
      kind: "turn-result",
    });
    expect(resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-error")).toEqual([]);
  });

  it("commits and releases background tasks before settling a cancelled turn", async () => {
    const initialState = createSessionState({ continuationToken: "http:parent" });
    const backgroundState = createSessionState({ continuationToken: "http:parent:background" });
    const backgroundTasks = [
      {
        taskId: "task-1",
        taskInboxToken: "task-inbox-1",
        taskRunId: "task-run-1",
      },
    ];
    installInbox([]);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "cancelled",
      backgroundTaskState: backgroundState,
      backgroundTasks,
      serializedContext: { state: "cancelled" },
      sessionState: initialState,
    });

    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      mode: "task",
      sessionState: initialState,
    });
    await turnWorkflow(input);

    expect(acknowledgeDelegatedTasksStep).toHaveBeenCalledWith({ tasks: backgroundTasks });
    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
      serializedContext: { state: "cancelled" },
      sessionState: backgroundState,
    });
  });

  it("honors cancellation observed while a durable turn step returns", async () => {
    const sessionState = createSessionState();
    const sessionModel = {
      id: "openai/gpt-5.6-sol",
      contextWindowTokens: 1_000_000,
    };
    installInbox([], { cancelPayloads: [{}] });
    vi.mocked(turnStep).mockImplementationOnce(async (stepInput) => {
      await vi.waitFor(() => expect(stepInput.abortSignal?.aborted).toBe(true));
      return {
        action: "done",
        output: "must not complete",
        serializedContext: {
          state: "done",
          [SessionDynamicModelReferenceKey.name]: sessionModel,
        },
        sessionState,
      };
    });

    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      sessionState,
    });
    await turnWorkflow(input);

    const cancelledContext = {
      state: "start",
      [SessionDynamicModelReferenceKey.name]: sessionModel,
    };
    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
      serializedContext: cancelledContext,
      sessionState,
    });
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        cancelled: true,
        kind: "park",
        serializedContext: cancelledContext,
        sessionState,
      },
      kind: "turn-result",
    });
    expect(resumeHookMock).not.toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({ kind: "done" }),
      }),
    );
  });

  it("runs uncancellable when the session cancel token is claimed by another run", async () => {
    const sessionState = createSessionState();
    installInbox([], { cancelConflict: { runId: "wrun_stale_prior_turn" } });
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      sessionState,
    });
    await turnWorkflow(input);

    // The stale claim degrades cancellation instead of failing the turn.
    expect(vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal).toBeUndefined();
    expect(resumeHookMock).toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({ kind: "turn-result" }),
    );
    expect(resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-error")).toEqual([]);
  });

  it("disposes the session cancel hook before publishing the turn result", async () => {
    const sessionState = createSessionState();
    installInbox([]);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      sessionState,
    });
    await turnWorkflow(input);

    // The next turn must never race this run's teardown, so disposal
    // precedes the terminal send.
    const cancelHook = createHookMock.mock.results.find(
      (result) => (result.value as { token?: string }).token === "turn-token:cancel",
    )?.value as { dispose: ReturnType<typeof vi.fn> };
    const resultCall = resumeHookMock.mock.calls.findIndex(
      (call) => call[1]?.kind === "turn-result",
    );
    expect(cancelHook.dispose).toHaveBeenCalled();
    expect(cancelHook.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      resumeHookMock.mock.invocationCallOrder[resultCall]!,
    );
  });

  it("registers no cancel hook when the driver cannot settle cancelled parks", async () => {
    const sessionState = createSessionState();
    installInbox([]);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input } = createInput({ driverCapabilities: { turnInbox: true }, sessionState });
    await turnWorkflow(input);

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal).toBeUndefined();
    expect(cancelHookTokens()).toEqual([]);
  });

  it("registers a cancel hook for a task session without a continuation alias", async () => {
    const sessionState = createSessionState({ continuationToken: "" });
    installInbox([]);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      mode: "task",
      sessionState,
    });
    await turnWorkflow(input);

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(cancelHookTokens()).toEqual(["turn-token:cancel"]);
  });

  it("deduplicates concurrent turn workflows through inbox ownership", async () => {
    const sessionState = createSessionState();
    const ownerInbox = createInboxMock([]);
    const duplicateInbox = createInboxMock([], {
      conflict: { runId: "wrun_owner" },
    });
    installHookDispatch([ownerInbox, duplicateInbox]);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "done",
      output: "ok",
      serializedContext: { state: "done" },
      sessionState,
    });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      sessionState,
    });
    await Promise.all([turnWorkflow(input), turnWorkflow(input)]);

    expect(turnStep).toHaveBeenCalledOnce();
    expect(
      resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result"),
    ).toHaveLength(1);
    expect(resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-error")).toEqual([]);
    expect(ownerInbox.dispose).toHaveBeenCalledOnce();
    expect(duplicateInbox.dispose).toHaveBeenCalledOnce();
    expect(ownerInbox.createIterator).toHaveBeenCalledOnce();
    expect(duplicateInbox.createIterator).toHaveBeenCalledOnce();
  });

  it("deduplicates a cross-realm inbox conflict rejection", async () => {
    const inbox = installInbox([], {
      claimError: {
        conflictingRunId: "wrun_owner",
        name: "HookConflictError",
        token: "turn-token:inbox",
      },
    });
    const { input } = createInput({ driverCapabilities: { turnInbox: true } });

    await turnWorkflow(input);

    expect(turnStep).not.toHaveBeenCalled();
    expect(resumeHookMock).not.toHaveBeenCalled();
    expect(inbox.dispose).toHaveBeenCalledOnce();
    expect(inbox.createIterator).toHaveBeenCalledOnce();
  });

  it("reports non-conflict inbox claim failures to the driver", async () => {
    const failure = new Error("hook storage unavailable");
    const inbox = installInbox([], { claimError: failure });
    const { input } = createInput({ driverCapabilities: { turnInbox: true } });

    await expect(turnWorkflow(input)).rejects.toBe(failure);

    expect(turnStep).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock.mock.calls[0]?.[0]).toBe("turn-token");
    expect(resumeHookMock.mock.calls[0]?.[1]).toMatchObject({ kind: "turn-error" });
    expect(inbox.dispose).toHaveBeenCalledOnce();
    expect(inbox.createIterator).toHaveBeenCalledOnce();
  });

  it("waits for dispatch adoption before cascading a cancellation", async () => {
    const initialState = createSessionState({ continuationToken: "http:parent" });
    const pendingState = createSessionState({ continuationToken: "http:parent:turn" });
    const adoptedState = createSessionState({ continuationToken: "http:parent:turn:adopted" });
    let finishDispatch:
      | ((value: {
          results: readonly [];
          sessionState: DurableSessionState;
          pendingTasks: readonly [];
        }) => void)
      | undefined;
    const dispatchResult = new Promise<{
      results: readonly [];
      sessionState: DurableSessionState;
      pendingTasks: readonly [];
    }>((resolve) => {
      finishDispatch = resolve;
    });
    installInbox([], { cancelPayloads: [{}], stayOpen: true });
    vi.mocked(dispatchCoordinationStep).mockReturnValue(dispatchResult);
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "cancelled",
        serializedContext: { state: "cancelled" },
        sessionState: adoptedState,
      });

    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      mode: "task",
      sessionState: initialState,
    });
    const workflow = turnWorkflow(input);
    await vi.waitFor(() => expect(dispatchCoordinationStep).toHaveBeenCalledOnce());
    expect(cancelDescendantTurnsStep).not.toHaveBeenCalled();

    finishDispatch?.({ results: [], sessionState: adoptedState, pendingTasks: [] });
    await workflow;

    expect(vi.mocked(turnStep).mock.calls[1]?.[0].abortSignal?.aborted).toBe(true);
    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
      serializedContext: { state: "cancelled" },
      sessionState: adoptedState,
    });
    expect(vi.mocked(dispatchCoordinationStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(cancelDescendantTurnsStep).mock.invocationCallOrder[0]!,
    );
  });

  it("keeps dynamic-workflow child dispatch and immediate remote failures in the same turn", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_345);
    const pendingState = createSessionState();
    const completedState = createSessionState();
    installInbox([]);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [
        {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          origin: "dispatch",
          output: { code: "REMOTE_AGENT_START_FAILED", message: "remote unavailable" },
          subagentName: "research",
        },
      ],
      sessionState: pendingState,
      pendingTasks: [],
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "dispatch-workflow-tasks",
        pendingTaskCallIds: ["call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "handled failure",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input, parentWritable } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(dispatchCoordinationStep).toHaveBeenCalledWith({
      action: "dispatch-workflow-tasks",
      callbackBaseUrl: "https://eve.example.com",
      parentContinuationToken: "turn-token:inbox",
      parentWritable,
      serializedContext: { state: "pending" },
      sessionState: pendingState,
    });
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({
      acceptedAtMsByCallId: { "call-1": 2_345 },
      kind: "runtime-action-result",
      results: [expect.objectContaining({ callId: "call-1", isError: true })],
    });
    expect(
      resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result"),
    ).toHaveLength(1);
    now.mockRestore();
  });

  it("proxies child HITL and pulls the response through the active turn", async () => {
    const runningChildren = [{ callId: "call-1", sessionId: "child-session" }];
    const pendingState = createSessionState();
    const proxyState = withRunningChildren(
      createSessionState({ hasProxyInputRequests: true }),
      runningChildren,
    );
    const retiredProxyState = withRunningChildren(createSessionState(), runningChildren);
    const completedState = createSessionState();
    const requestId = "turn-token:inbox:delivery:0";
    installInbox([
      {
        callId: "call-1",
        childContinuationToken: "subagent:parent:call-1",
        childSessionId: "child-session",
        event: { requests: [], sequence: 0, stepIndex: 0, turnId: "turn_0" },
        kind: "subagent-input-request",
        subagentName: "delegate",
      },
      {
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        },
        kind: "driver-delivery",
        requestId,
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "subagent-result",
            origin: "child",
            output: "approved child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      sessionState: withRunningChildren(pendingState, runningChildren),
      pendingTasks: [],
    });
    vi.mocked(runProxySubagentEventStep).mockResolvedValue({
      serializedContext: { state: "proxied" },
      sessionState: proxyState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: { state: "proxied" },
      sessionState: retiredProxyState,
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(runProxySubagentEventStep).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      continuationToken: "http:test",
      inboxToken: "turn-token:inbox",
      kind: "turn-delivery-request",
      requestId,
    });
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      kind: "turn-delivery-accepted",
      requestId,
    });
    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        },
        sessionState: proxyState,
      }),
    );
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].sessionState).toBe(retiredProxyState);
  });

  it("marks workflow-tool owner-channel input requests as answer hooks", async () => {
    const pendingState = createSessionState();
    const dispatchedState = withWorkflowToolRun(createSessionState());
    const proxyState = withWorkflowToolRun(createSessionState({ hasProxyInputRequests: true }));
    const retiredProxyState = withWorkflowToolRun(createSessionState());
    const completedState = createSessionState();
    const answerToken = "eve:workflow-tool-run-answer:run-1:0";
    const requestId = "turn-token:inbox:delivery:0";
    const workflowRequest = {
      from: {
        callId: "call-1",
        execution: "blocking" as const,
        input: { service: "api" },
        runId: "run-1",
        sequence: 0,
        stepIndex: 1,
        toolName: "confirm_deploy",
        turnId: "turn_0",
      },
      replyTo: answerToken,
      request: {
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
        prompt: "Approve deploy?",
      },
    };
    definedHookPayloads.set("turn-token:inbox:request", [workflowRequest]);
    installInbox([
      {
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: answerToken }] }],
        },
        kind: "driver-delivery",
        requestId,
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "tool-result",
            output: { approved: true, service: "api" },
            toolName: "confirm_deploy",
          },
        ],
      },
    ]);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      sessionState: dispatchedState,
      pendingTasks: [],
    });
    vi.mocked(runProxySubagentEventStep).mockResolvedValue({
      serializedContext: { state: "proxied" },
      sessionState: proxyState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: { state: "proxied" },
      sessionState: retiredProxyState,
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input, parentWritable } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(runProxySubagentEventStep).toHaveBeenCalledWith({
      answerHook: { runId: "run-1" },
      hookPayload: expect.objectContaining({
        childContinuationToken: answerToken,
        childSessionId: "run-1",
        kind: "subagent-input-request",
      }),
      parentWritable,
      serializedContext: { state: "pending" },
      sessionState: dispatchedState,
    });
    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: answerToken }] }],
        },
        sessionState: proxyState,
      }),
    );
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({
      acceptedAtMsByCallId: { "call-1": expect.any(Number) },
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "tool-result",
          output: { approved: true, service: "api" },
          toolName: "confirm_deploy",
        },
      ],
    });
  });

  it("routes blocking workflow agent lifecycle requests through the recorded run owner", async () => {
    const pendingState = createSessionState();
    const dispatchedState = withWorkflowToolRun(createSessionState(), "research");
    const invokedState = withWorkflowToolRun(createSessionState(), "research");
    const settledState = withWorkflowToolRun(createSessionState(), "research");
    const completedState = createSessionState();
    const childResult = {
      callId: "call-1",
      kind: "subagent-result" as const,
      origin: "child" as const,
      outcome: {
        kind: "parked" as const,
        result: { kind: "succeeded" as const, output: "done" },
        usageDelta: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      output: "done",
      subagentName: "research",
    };
    definedHookPayloads.set("turn-token:inbox:request", [
      {
        from: {
          callId: "call-1",
          execution: "blocking",
          input: {},
          resultKind: "subagent",
          runId: "run-1",
          sequence: 0,
          stepIndex: 0,
          toolName: "research",
          turnId: "turn_0",
        },
        replyTo: "agent-reply",
        request: {
          input: { message: "Find it", target: "research" },
          invocationId: "call-1",
          kind: "agent-invoke",
        },
      },
      {
        from: {
          callId: "call-1",
          execution: "blocking",
          input: {},
          resultKind: "subagent",
          runId: "run-1",
          sequence: 0,
          stepIndex: 0,
          toolName: "research",
          turnId: "turn_0",
        },
        replyTo: "agent-reply",
        request: { kind: "agent-settled", result: childResult },
      },
    ]);
    definedHookPayloads.set("turn-token:inbox:outcome", [
      {
        from: {
          callId: "call-1",
          execution: "blocking",
          input: {},
          resultKind: "subagent",
          runId: "run-1",
          sequence: 0,
          stepIndex: 0,
          toolName: "research",
          turnId: "turn_0",
        },
        result: { output: childResult, status: "completed" },
      },
    ]);
    installInbox([]);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      sessionState: dispatchedState,
      pendingTasks: [],
    });
    vi.mocked(applyTaskAgentRequest)
      .mockResolvedValueOnce({ serializedContext: {}, sessionState: invokedState })
      .mockResolvedValueOnce({ serializedContext: {}, sessionState: settledState });
    vi.mocked(releaseAgentInvocationOwnerStep).mockResolvedValue({ sessionState: settledState });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-1"],
        serializedContext: {},
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: {},
        sessionState: completedState,
      });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(vi.mocked(applyTaskAgentRequest).mock.calls.map(([delivery]) => delivery)).toEqual([
      expect.objectContaining({
        ownerId: "run-1",
        request: {
          kind: "agent-invoke",
          invocationId: "call-1",
          input: expect.any(Object),
          parentActionCallId: "call-1",
        },
      }),
      expect.objectContaining({
        ownerId: "run-1",
        request: { kind: "agent-settled", result: childResult },
      }),
    ]);
  });

  it("drops an unbound legacy child event before proxying it", async () => {
    const pendingState = createSessionState();
    installInbox([
      {
        callId: "call-1",
        childContinuationToken: "child-token",
        childSessionId: "wrong-child",
        event: { requests: [], sequence: 0, stepIndex: 0, turnId: "turn_0" },
        kind: "subagent-input-request",
        subagentName: "delegate",
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "subagent-result",
            origin: "child",
            output: "child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      sessionState: withRunningChildren(pendingState, [
        { callId: "call-1", sessionId: "child-session" },
      ]),
      pendingTasks: [],
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-1"],
        serializedContext: {},
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: {},
        sessionState: createSessionState(),
      });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(runProxySubagentEventStep).not.toHaveBeenCalled();
  });

  it("lets the parent cancel after a descendant consumes a session-limit Stop response", async () => {
    const pendingState = withRunningChildren(createSessionState(), [
      { callId: "call-1", sessionId: "child-session" },
    ]);
    const proxyState = createSessionState({ hasProxyInputRequests: true });
    const retiredProxyState = createSessionState();
    const requestId = "child-limit-request";
    installInbox([
      {
        callId: "call-1",
        childContinuationToken: "subagent:parent:call-1",
        childSessionId: "child-session",
        event: { requests: [], sequence: 0, stepIndex: 1, turnId: "turn_0" },
        kind: "subagent-input-request",
        subagentName: "delegate",
      },
      {
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "stop", requestId }] }],
        },
        kind: "driver-delivery",
        requestId: "turn-token:inbox:delivery:0",
      },
    ]);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
      pendingTasks: [],
    });
    vi.mocked(runProxySubagentEventStep).mockResolvedValue({
      serializedContext: { state: "proxied" },
      sessionState: proxyState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "cancel-turn",
      serializedContext: { state: "proxied" },
      sessionState: retiredProxyState,
    });
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      pendingCoordinationCallIds: ["call-1"],
      serializedContext: { state: "pending" },
      sessionState: pendingState,
    });

    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      mode: "conversation",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
      serializedContext: { state: "proxied" },
      sessionState: retiredProxyState,
    });
    expect(turnStep).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        cancelled: true,
        kind: "park",
        serializedContext: { state: "proxied" },
        sessionState: retiredProxyState,
      },
      kind: "turn-result",
    });
  });

  it("proxies child authorization lifecycle events while continuing to await its result", async () => {
    const runningChildren = [{ callId: "call-1", sessionId: "child-session" }];
    const pendingState = createSessionState();
    const requiredState = withRunningChildren(createSessionState(), runningChildren);
    const completedAuthState = withRunningChildren(createSessionState(), runningChildren);
    const completedState = createSessionState();
    const requiredEvent = {
      data: {
        authorization: { displayName: "Linear", url: "https://idp.example/authorize" },
        description: "Authorization required for linear",
        name: "linear",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn_0",
        webhookUrl: "https://eve.example/connections/linear/callback/child%3Aauth",
      },
      type: "authorization.required" as const,
    };
    const completedEvent = {
      data: {
        authorization: { displayName: "Linear", url: "https://idp.example/authorize" },
        name: "linear",
        outcome: "authorized" as const,
        sequence: 0,
        stepIndex: 2,
        turnId: "turn_0",
      },
      type: "authorization.completed" as const,
    };
    installInbox([
      {
        callId: "call-1",
        childSessionId: "child-session",
        event: requiredEvent,
        kind: "subagent-authorization-event",
        subagentName: "delegate",
      },
      {
        callId: "call-1",
        childSessionId: "child-session",
        event: completedEvent,
        kind: "subagent-authorization-event",
        subagentName: "delegate",
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "subagent-result",
            origin: "child",
            output: "authorized child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    const dispatchedState = withRunningChildren(pendingState, runningChildren);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      sessionState: dispatchedState,
      pendingTasks: [],
    });
    vi.mocked(runProxySubagentEventStep)
      .mockResolvedValueOnce({
        serializedContext: { state: "auth-required" },
        sessionState: requiredState,
      })
      .mockResolvedValueOnce({
        serializedContext: { state: "auth-completed" },
        sessionState: completedAuthState,
      });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input, parentWritable } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    expect(vi.mocked(runProxySubagentEventStep).mock.calls).toEqual([
      [
        {
          hookPayload: expect.objectContaining({ event: requiredEvent }),
          parentWritable,
          serializedContext: { state: "pending" },
          sessionState: dispatchedState,
        },
      ],
      [
        {
          hookPayload: expect.objectContaining({ event: completedEvent }),
          parentWritable,
          serializedContext: { state: "auth-required" },
          sessionState: requiredState,
        },
      ],
    ]);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0]).toMatchObject({
      input: {
        kind: "runtime-action-result",
        results: [expect.objectContaining({ output: "authorized child output" })],
      },
      serializedContext: { state: "auth-completed" },
      sessionState: completedAuthState,
    });
    expect(resumeHookMock).not.toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({ kind: "turn-delivery-request" }),
    );
    expect(routeDeliverToChildren).not.toHaveBeenCalled();
    expect(
      resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result"),
    ).toHaveLength(1);
  });

  it("mints a unique delivery request id per wait so a stale forward is not re-accepted", async () => {
    const pendingState = createSessionState({ hasProxyInputRequests: true });
    const completedState = createSessionState();
    // The first wait resolves on its child result while a delivery forwarded for
    // request `:delivery:0` is still queued behind it. The second wait must mint
    // a fresh id so that stale forward is dropped, not mistaken for its response.
    installInbox([
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "subagent-result",
            origin: "child",
            output: "first",
            subagentName: "delegate",
          },
        ],
      },
      {
        delivery: {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        },
        kind: "driver-delivery",
        requestId: "turn-token:inbox:delivery:0",
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-2",
            kind: "subagent-result",
            origin: "child",
            output: "second",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      sessionState: withRunningChildren(pendingState, [
        { callId: "call-1", sessionId: "child-session-1" },
        { callId: "call-2", sessionId: "child-session-2" },
      ]),
      pendingTasks: [],
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: {},
      sessionState: pendingState,
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-1"],
        serializedContext: { state: "batch-1" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["call-2"],
        serializedContext: { state: "batch-2" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: pendingState,
    });
    await turnWorkflow(input);

    const deliveryRequestIds = resumeHookMock.mock.calls
      .filter((call) => call[1]?.kind === "turn-delivery-request")
      .map((call) => call[1]?.requestId);
    expect(deliveryRequestIds).toEqual([
      "turn-token:inbox:delivery:0",
      "turn-token:inbox:delivery:1",
    ]);
    expect(resumeHookMock).not.toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({ kind: "turn-delivery-accepted" }),
    );
    expect(routeDeliverToChildren).not.toHaveBeenCalled();
  });
});

interface InboxMock {
  readonly createIterator: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly hook: unknown;
}

function installInbox(
  values: readonly unknown[],
  options: {
    readonly cancelConflict?: { readonly runId: string } | null;
    readonly cancelPayloads?: readonly unknown[];
    readonly claimError?: unknown;
    readonly conflict?: { readonly runId: string } | null;
    readonly stayOpen?: boolean;
  } = {},
): InboxMock {
  const inbox = createInboxMock(values, options);
  installHookDispatch([inbox], {
    conflict: options.cancelConflict ?? null,
    payloads: options.cancelPayloads ?? [],
  });
  return inbox;
}

/**
 * Routes inbox tokens to the queued inbox mocks and `:cancel` tokens to
 * cancel hooks (inert by default — their reads never resolve, so no
 * cancellation is ever observed unless a test provides payloads or a
 * claim conflict via `cancelOptions`).
 */
function installHookDispatch(
  inboxes: readonly InboxMock[],
  cancelOptions: {
    readonly conflict?: { readonly runId: string } | null;
    readonly payloads?: readonly unknown[];
  } = {},
): void {
  const queue = [...inboxes];
  createHookMock.mockImplementation((input: { token: string }) =>
    input.token.endsWith(":cancel")
      ? createCancelHookMock(input.token, cancelOptions)
      : queue.shift()?.hook,
  );
}

function cancelHookTokens(): string[] {
  return createHookMock.mock.calls
    .map((call) => (call[0] as { token: string }).token)
    .filter((token) => token.endsWith(":cancel"));
}

function createCancelHookMock(
  token: string,
  options: {
    readonly conflict?: { readonly runId: string } | null;
    readonly payloads?: readonly unknown[];
  } = {},
): unknown {
  const queue = [...(options.payloads ?? [])];
  return {
    token,
    getConflict: vi.fn(async () => options.conflict ?? null),
    dispose: vi.fn(),
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: () => {
          const value = queue.shift();
          return value === undefined
            ? new Promise<IteratorResult<unknown>>(() => {})
            : Promise.resolve({ done: false, value });
        },
        return: vi.fn(async () => ({ done: true, value: undefined })),
      };
    },
  };
}

function createInboxMock(
  values: readonly unknown[],
  options: {
    readonly claimError?: unknown;
    readonly conflict?: { readonly runId: string } | null;
    readonly stayOpen?: boolean;
  } = {},
): InboxMock {
  const queue = [...values];
  const dispose = vi.fn();
  const createIterator = vi.fn(() => ({
    next: vi.fn(async () => {
      const value = queue.shift();
      if (value !== undefined) return { done: false, value };
      if (options.stayOpen === true) return await new Promise<never>(() => {});
      return { done: true, value: undefined };
    }),
    return: vi.fn(async () => ({ done: true, value: undefined })),
  }));
  const hook = {
    token: "turn-token:inbox",
    getConflict: vi.fn(async () => {
      if (options.claimError !== undefined) throw options.claimError;
      return options.conflict ?? null;
    }),
    dispose,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return createIterator();
    },
  };
  return { createIterator, dispose, hook };
}

function createInput(
  overrides: Partial<Omit<TurnWorkflowInput, "stepInput" | "version">> & {
    readonly sessionState?: DurableSessionState;
  } = {},
): {
  readonly input: TurnWorkflowInput;
  readonly parentWritable: WritableStream<Uint8Array>;
} {
  const { sessionState = createSessionState(), ...workflowOverrides } = overrides;
  const parentWritable = new WritableStream<Uint8Array>();
  return {
    input: {
      capabilities: undefined,
      completionToken: "turn-token",
      mode: "conversation",
      stepInput: {
        input: { kind: "deliver", payloads: [{ message: "hello" }] } satisfies HookPayload,
        parentWritable,
        serializedContext: { state: "start" },
        sessionState,
      },
      ...workflowOverrides,
      version: TURN_WORKFLOW_INPUT_VERSION,
    },
    parentWritable,
  };
}

function createSessionState(overrides: Partial<DurableSessionState> = {}): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "wrun_test_123",
    version: 1,
    ...overrides,
  };
}

/**
 * Embeds a snapshot whose handle store owns each child as `running`, the
 * shape the dispatch step commits: inbox results only resolve the wait when
 * a running handle binds their callId to their claimed sessionId.
 */
function withRunningChildren(
  state: DurableSessionState,
  children: readonly { readonly callId: string; readonly sessionId: string }[],
): DurableSessionState {
  return {
    ...state,
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: state.continuationToken,
        history: [],
        sessionId: state.sessionId,
        state: {
          [AGENT_HANDLES_STATE_KEY]: {
            handles: children.map((child) => ({
              address: {
                continuationToken: `subagent:parent:${child.callId}`,
                kind: "agent/local",
                sessionId: child.sessionId,
              },
              identity: {
                id: `ag_delegate:${child.callId}`,
                name: "delegate",
                nodeId: "subagents/delegate",
              },
              operation: {
                callId: child.callId,
                id: `op-${child.callId}`,
                kind: "start",
                parentTurnId: "turn_0",
              },
              phase: "running",
            })),
          },
        },
      },
      version: 1,
    },
  };
}

function withWorkflowToolRun(
  state: DurableSessionState,
  toolName = "confirm_deploy",
): DurableSessionState {
  const baseSession: HarnessSession = {
    agent: { dynamicModel: true, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
    continuationToken: state.continuationToken,
    history: [],
    sessionId: state.sessionId,
  };
  const session = recordWorkflowToolRun(baseSession, {
    callId: "call-1",
    hookToken: "eve:workflow-tool-run:run-1",
    runId: "run-1",
    resultKind: toolName === "research" ? "subagent" : undefined,
    toolName,
  });
  return {
    ...state,
    snapshot: {
      session,
      version: 1,
    },
  };
}
