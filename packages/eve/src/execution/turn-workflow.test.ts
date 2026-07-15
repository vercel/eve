import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookPayload } from "#channel/types.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { runProxySubagentEventStep } from "#execution/subagent-event-proxy-step.js";
import { turnWorkflow } from "#execution/turn-workflow.js";
import {
  TURN_WORKFLOW_INPUT_VERSION,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { turnStep } from "#execution/workflow-steps.js";

const resumeHookMock = vi.fn();
const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  getWorkflowMetadata: vi.fn(() => ({ url: "https://eve.example.com" })),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

vi.mock("./subagent-event-proxy-step.js", () => ({
  runProxySubagentEventStep: vi.fn(),
}));

vi.mock("./workflow-steps.js", () => ({
  turnStep: vi.fn(),
}));

vi.mock("./dispatch-runtime-actions-step.js", () => ({
  dispatchRuntimeActionsStep: vi.fn(),
}));

vi.mock("./dispatch-workflow-runtime-actions-step.js", () => ({
  dispatchWorkflowRuntimeActionsStep: vi.fn(),
}));

vi.mock("./workflow-callback-url.js", () => ({
  resolveWorkflowCallbackBaseUrl: vi.fn((metadataUrl: string) => metadataUrl),
}));

describe("turnWorkflow", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resumeHookMock.mockReset();
    createHookMock.mockReset();
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
      pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
      serializedContext: { state: "pending-runtime-action" },
      sessionState,
    });

    const { input } = createInput({ mode: "task", sessionState });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        kind: "dispatch-runtime-actions",
        pendingActionKeys: ["subagent-call:delegate:call-1"],
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
    installInbox([]);
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "cancelled",
      serializedContext: { state: "cancelled" },
      sessionState,
    });

    // Task mode on purpose: cancellation bypasses the `canPark` gate.
    const { input } = createInput({
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      mode: "task",
      sessionState,
    });
    await turnWorkflow(input);

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
    // The cancel token is session-scoped so a trigger can derive it from
    // the session id alone.
    expect(cancelHookTokens()).toEqual(["wrun_test_123:cancel"]);
    // The cancelled result is a pure marker: the control payload carries
    // the cursor's last settled state, not the aborted step's echo.
    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      action: {
        cancelled: true,
        kind: "park",
        serializedContext: { state: "start" },
        sessionState,
      },
      kind: "turn-result",
    });
    expect(resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-error")).toEqual([]);
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

    // The token is stable across turns: the next turn's claim must never
    // race this run's teardown, so disposal precedes the terminal send.
    const cancelHook = createHookMock.mock.results.find(
      (result) => (result.value as { token?: string }).token === "wrun_test_123:cancel",
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

  it("registers no cancel hook when the session cannot park", async () => {
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

    expect(vi.mocked(turnStep).mock.calls[0]?.[0].abortSignal).toBeUndefined();
    expect(cancelHookTokens()).toEqual([]);
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

  it("keeps a local subagent result inside one turn workflow", async () => {
    const initialState = createSessionState({ continuationToken: "slack:C1:" });
    const pendingState = createSessionState({ continuationToken: "slack:C1:T1" });
    const completedState = createSessionState({ continuationToken: "slack:C1:T1" });
    installInbox([
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
        serializedContext: { state: "pending" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "parent output",
        serializedContext: { state: "done" },
        sessionState: completedState,
      });

    const { input, parentWritable } = createInput({
      driverCapabilities: { turnInbox: true },
      mode: "task",
      sessionState: initialState,
    });
    await turnWorkflow(input);

    expect(resumeHookMock).toHaveBeenCalledWith("turn-token", {
      continuationToken: "slack:C1:T1",
      kind: "turn-continuation-token",
    });
    expect(resumeHookMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchRuntimeActionsStep).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(dispatchRuntimeActionsStep).toHaveBeenCalledWith({
      callbackBaseUrl: "https://eve.example.com",
      parentContinuationToken: "turn-token:inbox",
      parentWritable,
      serializedContext: { state: "pending" },
      sessionState: pendingState,
    });
    expect(vi.mocked(turnStep).mock.calls[1]?.[0]).toMatchObject({
      input: {
        kind: "runtime-action-result",
        results: [expect.objectContaining({ callId: "call-1", output: "child output" })],
      },
    });
    expect(resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result")).toEqual([
      [
        "turn-token",
        expect.objectContaining({
          action: expect.objectContaining({ kind: "done", output: "parent output" }),
        }),
      ],
    ]);
    expect(resumeHookMock).not.toHaveBeenCalledWith(
      "turn-token",
      expect.objectContaining({
        action: expect.objectContaining({ kind: "dispatch-runtime-actions" }),
      }),
    );
  });

  it("keeps dynamic-workflow child dispatch and immediate remote failures in the same turn", async () => {
    const pendingState = createSessionState();
    const completedState = createSessionState();
    installInbox([]);
    vi.mocked(dispatchWorkflowRuntimeActionsStep).mockResolvedValue({
      results: [
        {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          output: { code: "REMOTE_AGENT_START_FAILED", message: "remote unavailable" },
          subagentName: "research",
        },
      ],
      sessionState: pendingState,
    });
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "dispatch-workflow-runtime-actions",
        pendingRuntimeActionKeys: ["subagent-call:research:call-1"],
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

    expect(dispatchWorkflowRuntimeActionsStep).toHaveBeenCalledWith({
      callbackBaseUrl: "https://eve.example.com",
      parentContinuationToken: "turn-token:inbox",
      parentWritable,
      serializedContext: { state: "pending" },
      sessionState: pendingState,
    });
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({
      kind: "runtime-action-result",
      results: [expect.objectContaining({ callId: "call-1", isError: true })],
    });
    expect(
      resumeHookMock.mock.calls.filter((call) => call[1]?.kind === "turn-result"),
    ).toHaveLength(1);
  });

  it("proxies child HITL and pulls the response through the active turn", async () => {
    const pendingState = createSessionState();
    const proxyState = createSessionState({ hasProxyInputRequests: true });
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
            output: "approved child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
    });
    vi.mocked(runProxySubagentEventStep).mockResolvedValue({
      serializedContext: { state: "proxied" },
      sessionState: proxyState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue(undefined);
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
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
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        sessionState: proxyState,
      }),
    );
  });

  it("proxies child authorization lifecycle events while continuing to await its result", async () => {
    const pendingState = createSessionState();
    const requiredState = createSessionState();
    const completedAuthState = createSessionState();
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
            output: "authorized child output",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
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
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
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
          sessionState: pendingState,
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
          { callId: "call-1", kind: "subagent-result", output: "first", subagentName: "delegate" },
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
            output: "second",
            subagentName: "delegate",
          },
        ],
      },
    ]);
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValue({
      results: [],
      sessionState: pendingState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue(undefined);
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-1"],
        serializedContext: { state: "batch-1" },
        sessionState: pendingState,
      })
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingRuntimeActionKeys: ["subagent-call:delegate:call-2"],
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
  } = {},
): InboxMock {
  const queue = [...values];
  const dispose = vi.fn();
  const createIterator = vi.fn(() => ({
    next: vi.fn(async () => {
      const value = queue.shift();
      return value === undefined ? { done: true, value: undefined } : { done: false, value };
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
