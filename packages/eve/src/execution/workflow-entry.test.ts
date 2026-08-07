import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHook } from "#compiled/@workflow/core/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";

import type { HookPayload } from "#channel/types.js";
import { ChannelRequestIdKey, SubagentDepthKey } from "#context/keys.js";
import { createSessionStep } from "#execution/create-session-step.js";
import {
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#execution/delegated-parent-notification.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import {
  createSessionTimeoutControl,
  type SessionTimeoutControl,
} from "#execution/session-timeout-control.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { dispatchTurnStep } from "#execution/workflow-steps.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import type { SessionInboxPayload } from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
  getWorkflowMetadata: vi.fn(() => ({
    url: "https://eve.example.com",
    workflowRunId: "wrun_test_123",
    workflowStartedAt: new Date("2026-01-01T00:00:00.000Z"),
  })),
  getWritable: vi.fn(
    () =>
      new WritableStream<Uint8Array>({
        write() {},
      }),
  ),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

vi.mock("./create-session-step.js", () => ({
  createSessionStep: vi.fn().mockResolvedValue(
    createSessionStepResultForMock(
      createSessionStateForMock({
        continuationToken: "http:test",
        sessionId: "wrun_test_123",
      }),
    ),
  ),
}));

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn().mockImplementation(async ({ payloads }) => ({
    kind: "continue",
    remainder: payloads[0],
  })),
}));

vi.mock("./delegated-parent-notification.js", () => ({
  notifyDelegatedParentStep: vi.fn().mockResolvedValue(undefined),
  notifyTurnCallerStep: vi.fn().mockResolvedValue(undefined),
  resolveInitialTurnCallerStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./terminate-child-sessions-step.js", () => ({
  terminateChildSessionsStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./workflow-steps.js", () => ({
  dispatchTurnStep: vi.fn().mockImplementation(async () => ({ runId: "turn-run" })),
}));

vi.mock("./terminal-session-failure-step.js", () => ({
  emitTerminalSessionFailureStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./terminal-session-completion-step.js", () => ({
  emitTerminalSessionCompletionStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./settle-cancelled-turn-step.js", () => ({
  settleCancelledTurnStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./session-timeout-control.js", () => ({
  createSessionTimeoutControl: vi.fn(),
}));

function createSessionStateForMock(
  overrides: Partial<DurableSessionState> = {},
): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "wrun_test_123",
    version: 1,
    ...overrides,
  };
}

function createSessionStepResultForMock(state: DurableSessionState) {
  return {
    identity: { agentId: "test-agent", nodeId: "$root" },
    state,
  };
}

vi.mock("./session-callback-step.js", () => ({
  fireSessionCallbackStep: vi.fn().mockResolvedValue(undefined),
}));

interface DeliveryHookConfig {
  readonly dispose?: () => void;
  readonly getConflict?: () => Promise<{ readonly runId: string } | null>;
  readonly next?: () => Promise<IteratorResult<SessionInboxPayload>>;
  readonly return?: () => Promise<IteratorResult<SessionInboxPayload>>;
  readonly token: string;
  readonly values?: readonly SessionInboxPayload[];
}

interface AuthHookConfig {
  readonly dispose?: () => void;
  readonly return?: () => Promise<IteratorResult<HookPayload>>;
}

describe("workflowEntry", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.mocked(createSessionTimeoutControl).mockReturnValue(createTimeoutControl());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("injects the workflow run id as the canonical session id before the first turn", async () => {
    const sessionState = createBaseSessionState();
    const getConflict = vi.fn(async () => null);
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [{ getConflict, token: "http:test" }],
      turnControls: [
        turnResult({
          action: "done",
          output: "ok",
          serializedContext: { "eve.sessionId": "wrun_test_123" },
          sessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "ok" });
    expect(createSessionTimeoutControl).toHaveBeenCalledWith({
      deadline: new Date("2026-01-31T00:00:00.000Z"),
      token: sessionCommandHookToken("wrun_test_123"),
    });
    expect(createSessionStep).toHaveBeenCalledWith({
      compiledArtifactsSource: {},
      continuationToken: "http:test",
      nodeId: undefined,
      sessionId: "wrun_test_123",
    });
    expect(dispatchTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({
        completionToken: expect.any(String),
        delivery: {
          kind: "deliver",
          payloads: [{ message: "hello there", context: undefined }],
        },
        serializedContext: expect.objectContaining({
          "eve.continuationToken": "http:test",
          "eve.mode": "conversation",
          "eve.sessionId": "wrun_test_123",
        }),
        sessionState,
      }),
    );
    expect(getConflict).toHaveBeenCalledOnce();
    expect(getConflict.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchTurnStep).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(terminateChildSessionsStep).toHaveBeenCalledWith({ sessionState });
  });

  it("exits a conflicting initial continuation before dispatching the first turn", async () => {
    const sessionState = createBaseSessionState();
    const dispose = vi.fn();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [
        {
          dispose,
          getConflict: vi.fn(async () => ({ runId: "wrun_owner" })),
          token: "http:test",
        },
      ],
      turnControls: [],
    });

    await expect(
      workflowEntry({
        input: { message: "duplicate" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "" });

    expect(emitTerminalSessionFailureStep).not.toHaveBeenCalled();
    expect(dispatchTurnStep).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("also exits when a legacy world reports the initial continuation conflict", async () => {
    const sessionState = createBaseSessionState();
    const dispose = vi.fn();
    const fallbackError = Object.assign(new Error("legacy hook conflict"), {
      name: "HookConflictError",
      token: "http:test",
    });
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [
        {
          dispose,
          getConflict: vi.fn(async () => {
            throw fallbackError;
          }),
          token: "http:test",
        },
      ],
      turnControls: [],
    });

    await expect(
      workflowEntry({
        input: { message: "duplicate" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "" });

    expect(emitTerminalSessionFailureStep).not.toHaveBeenCalled();
    expect(dispatchTurnStep).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("passes the run channel request id to the first turn", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      turnControls: [turnResult({ action: "done", output: "ok", sessionState })],
    });

    await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext({
        [ChannelRequestIdKey.name]: "req_initial",
      }),
    });

    expect(vi.mocked(dispatchTurnStep).mock.calls[0]?.[0].delivery).toEqual({
      requestId: "req_initial",
      kind: "deliver",
      payloads: [{ message: "hello there", context: undefined }],
    });
  });

  it("passes delegated subagent lineage and inherited limits to session creation", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      turnControls: [turnResult({ action: "done", output: "ok", sessionState })],
    });

    await workflowEntry({
      input: { message: "hello there" },
      limits: { maxInputTokensPerSession: 4 },
      serializedContext: createSerializedContext({
        [SubagentDepthKey.name]: 3,
      }),
    });

    expect(createSessionStep).toHaveBeenCalledWith(
      expect.objectContaining({
        inheritedLimits: { maxInputTokensPerSession: 4 },
        subagentDepth: 3,
      }),
    );
  });

  it("completes a parked session when its durable deadline elapses", async () => {
    const sessionState = createBaseSessionState();
    const dispose = vi.fn();
    const timeoutControl = createTimeoutControl();
    vi.mocked(createSessionTimeoutControl).mockReturnValueOnce(timeoutControl);
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [
        {
          dispose,
          next: () => new Promise<IteratorResult<SessionInboxPayload>>(() => {}),
          token: "http:test",
        },
      ],
      stableHook: { values: [{ kind: "session-timeout" }] },
      turnControls: [turnResult({ action: "park", sessionState })],
    });

    await expect(
      workflowEntry({
        input: { message: "hello there" },
        serializedContext: createSerializedContext(),
        sessionTimeoutMs: 1_000,
      }),
    ).resolves.toEqual({ output: "" });

    expect(createSessionTimeoutControl).toHaveBeenCalledWith({
      deadline: new Date("2026-01-01T00:00:01.000Z"),
      token: sessionCommandHookToken("wrun_test_123"),
    });
    expect(timeoutControl.dispose).toHaveBeenCalledOnce();
    expect(terminateChildSessionsStep).toHaveBeenCalledWith({ sessionState });
    expect(emitTerminalSessionFailureStep).not.toHaveBeenCalled();
    expect(emitTerminalSessionCompletionStep).toHaveBeenCalledWith({
      parentWritable: expect.any(WritableStream),
      serializedContext: { "eve.sessionId": "wrun_test_123" },
    });
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emitTerminalSessionCompletionStep).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(fireSessionCallbackStep).not.toHaveBeenCalled();
    expect(notifyTurnCallerStep).toHaveBeenCalledWith({
      caller: undefined,
      lifecycle: "terminal",
      sessionId: "wrun_test_123",
      settled: { output: "" },
    });
  });

  it("dispatches a compact control without converting it into a delivery", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [{ kind: "compact" }, { kind: "session-timeout" }],
        },
      ],
      turnControls: [
        turnResult({ action: "park", sessionState }),
        turnResult({ action: "park", sessionState }),
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "hello there" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "" });

    expect(dispatchTurnStep).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({ kind: "compact" });
    expect(routeDeliverToChildren).not.toHaveBeenCalled();
  });

  it("dispatches a clear control without converting it into a delivery", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [{ kind: "clear" }, { kind: "session-timeout" }],
        },
      ],
      turnControls: [
        turnResult({ action: "park", sessionState }),
        turnResult({ action: "park", sessionState }),
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "hello there" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "" });

    expect(dispatchTurnStep).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({ kind: "clear" });
    expect(routeDeliverToChildren).not.toHaveBeenCalled();
  });

  it("completes at the deadline after the active turn settles", async () => {
    const sessionState = createBaseSessionState();
    const dispose = vi.fn();
    let settleTurn: ((result: IteratorResult<TurnControlPayload>) => void) | undefined;
    const activeTurn = new Promise<IteratorResult<TurnControlPayload>>((resolve) => {
      settleTurn = resolve;
    });

    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    let deliveredTimeout = false;
    vi.mocked(createHook).mockImplementation((options?: { readonly token?: string }) => {
      const token = options?.token ?? "";
      if (isTurnCompletionToken(token)) {
        return createMockHook({
          next: () => activeTurn,
          token,
          values: [],
        }) as never;
      }
      if (token.endsWith(":auth")) {
        return createMockHook({ token, values: [] }) as never;
      }
      return token === sessionCommandHookToken("wrun_test_123")
        ? (createMockHook({
            dispose,
            next: () => {
              if (deliveredTimeout) {
                return new Promise<IteratorResult<SessionInboxPayload>>(() => {});
              }
              deliveredTimeout = true;
              return Promise.resolve({ done: false, value: { kind: "session-timeout" } });
            },
            token,
            values: [],
          }) as never)
        : (createMockHook({
            dispose,
            next: () => new Promise<IteratorResult<SessionInboxPayload>>(() => {}),
            token,
            values: [],
          }) as never);
    });

    const result = workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
      sessionTimeoutMs: 1,
    });

    await vi.waitFor(() => {
      expect(dispatchTurnStep).toHaveBeenCalledOnce();
    });
    expect(emitTerminalSessionCompletionStep).not.toHaveBeenCalled();

    settleTurn?.({
      done: false,
      value: turnResult({ action: "park", sessionState }),
    });

    await expect(result).resolves.toEqual({ output: "" });
    expect(emitTerminalSessionCompletionStep).toHaveBeenCalledOnce();
  });

  it("allows the session timeout to be disabled", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      turnControls: [turnResult({ action: "done", output: "ok", sessionState })],
    });

    await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
      sessionTimeoutMs: false,
    });

    expect(createSessionTimeoutControl).not.toHaveBeenCalled();
  });

  it("notifies a delegated parent once when a turn fails terminally", async () => {
    const sessionState = createBaseSessionState();
    const caller = {
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "parent-token" },
      subagentName: "researcher",
    };
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    vi.mocked(resolveInitialTurnCallerStep).mockResolvedValueOnce(caller);
    installHookMocks({
      turnControls: [
        {
          error: { message: "persistent recoverable failure", name: "Error" },
          kind: "turn-error",
        },
      ],
    });
    const serializedContext = createSerializedContext({
      "eve.channel": {
        kind: "subagent",
        state: {
          callId: "call-1",
          parentContinuationToken: "parent-token",
          subagentName: "researcher",
        },
      },
    });

    await expect(
      workflowEntry({
        input: { message: "delegate" },
        serializedContext,
      }),
    ).rejects.toMatchObject({
      message: "Agent workflow failed. Inspect the private session trace for details.",
      name: "EveWorkflowFailure",
    });

    expect(emitTerminalSessionFailureStep).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "persistent recoverable failure" }),
      }),
    );
    expect(terminateChildSessionsStep).toHaveBeenCalledWith({ sessionState });
    expect(notifyDelegatedParentStep).not.toHaveBeenCalled();
    expect(notifyTurnCallerStep).toHaveBeenCalledOnce();
    expect(notifyTurnCallerStep).toHaveBeenCalledWith({
      caller,
      lifecycle: "terminal",
      sessionId: "wrun_test_123",
      settled: {
        isError: true,
        output: expect.objectContaining({
          message: "persistent recoverable failure",
          name: "Error",
        }),
      },
    });
    expect(fireSessionCallbackStep).not.toHaveBeenCalled();
    // The caller cell was already populated; the crash path must reuse it
    // instead of resolving a second time.
    expect(resolveInitialTurnCallerStep).toHaveBeenCalledOnce();
  });

  it("rejects the delegated caller when the session fails before the caller is resolved", async () => {
    const caller = {
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "parent-token" },
      subagentName: "researcher",
    };
    // Crash before `resolveInitialTurnCallerStep` ever runs: the cleanup
    // cell is unpopulated, so the catch must re-resolve the caller from the
    // serialized context or the delegated parent's call parks forever.
    vi.mocked(createSessionStep).mockRejectedValueOnce(new Error("session creation failed"));
    vi.mocked(resolveInitialTurnCallerStep).mockResolvedValueOnce(caller);
    const serializedContext = createSerializedContext({
      "eve.channel": {
        kind: "subagent",
        state: {
          callId: "call-1",
          parentContinuationToken: "parent-token",
          subagentName: "researcher",
        },
      },
    });

    await expect(
      workflowEntry({
        input: { message: "delegate" },
        serializedContext,
      }),
    ).rejects.toMatchObject({ name: "EveWorkflowFailure" });

    expect(resolveInitialTurnCallerStep).toHaveBeenCalledOnce();
    expect(notifyTurnCallerStep).toHaveBeenCalledOnce();
    expect(notifyTurnCallerStep).toHaveBeenCalledWith({
      caller,
      lifecycle: "terminal",
      sessionId: "wrun_test_123",
      settled: {
        isError: true,
        output: expect.objectContaining({ message: "session creation failed" }),
      },
    });
    // No snapshot was ever received, so there are no children to terminate.
    expect(terminateChildSessionsStep).not.toHaveBeenCalled();
  });

  it("does not re-resolve a caller the loop already settled and cleared", async () => {
    // A crash after a settled reply cleared the cell must notify no one:
    // `caller: undefined` with the resolution flag set means "nothing left
    // to notify", not "never resolved".
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    vi.mocked(resolveInitialTurnCallerStep).mockResolvedValueOnce(undefined);
    installHookMocks({
      turnControls: [
        {
          error: { message: "root turn crashed", name: "Error" },
          kind: "turn-error",
        },
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "hello" },
        serializedContext: createSerializedContext(),
      }),
    ).rejects.toMatchObject({ name: "EveWorkflowFailure" });

    expect(resolveInitialTurnCallerStep).toHaveBeenCalledOnce();
    expect(notifyTurnCallerStep).toHaveBeenCalledWith(
      expect.objectContaining({ caller: undefined }),
    );
  });

  it("notifies the latest delegated exchange when a resumed turn fails terminally", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    const serializedContext = createSerializedContext({
      "eve.channel": {
        kind: "subagent",
        state: {
          callId: "call-original",
          parentContinuationToken: "original-parent-turn",
          subagentName: "researcher",
        },
      },
    });
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [
            {
              caller: {
                callId: "call-latest",
                replyTo: { kind: "hook", token: "latest-parent-turn" },
                subagentName: "researcher",
              },
              kind: "send",
              payload: { message: "follow up" },
            },
          ],
        },
      ],
      turnControls: [
        turnResult({ action: "park", sessionState }),
        {
          action: {
            isError: true,
            kind: "done",
            output: "follow-up failed",
            serializedContext,
            sessionState,
          },
          kind: "turn-result",
        },
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "delegate" },
        serializedContext,
      }),
    ).resolves.toEqual({ output: "follow-up failed" });

    expect(notifyTurnCallerStep).toHaveBeenCalledWith({
      caller: {
        callId: "call-latest",
        replyTo: { kind: "hook", token: "latest-parent-turn" },
        subagentName: "researcher",
      },
      lifecycle: "terminal",
      sessionId: "wrun_test_123",
      settled: {
        isError: true,
        output: "follow-up failed",
      },
    });
    expect(fireSessionCallbackStep).not.toHaveBeenCalled();
  });

  it("rekeys the delivery hook before notifying a delegated settled turn", async () => {
    const initialState = createBaseSessionState({ continuationToken: "" });
    const parkedState = createBaseSessionState({ continuationToken: "subagent:child" });
    const caller = {
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "parent-turn" },
      subagentName: "researcher",
    };
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(initialState));
    vi.mocked(resolveInitialTurnCallerStep).mockResolvedValueOnce(caller);
    const serializedContext = createSerializedContext({
      "eve.channel": {
        kind: "subagent",
        state: {
          callId: "call-1",
          parentContinuationToken: "parent-turn",
          subagentName: "researcher",
        },
      },
      "eve.continuationToken": "",
    });
    installHookMocks({
      deliveryHooks: [{ token: "subagent:child", values: [] }],
      turnControls: [
        turnResult({
          action: "park",
          serializedContext,
          sessionState: parkedState,
          settled: { output: "settled answer" },
        }),
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "delegate" },
        serializedContext,
      }),
    ).resolves.toEqual({ output: "" });

    const rekeyCall = vi
      .mocked(createHook)
      .mock.calls.find((call) => call[0]?.token === "subagent:child");
    expect(rekeyCall).toBeDefined();
    expect(vi.mocked(createHook).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(notifyTurnCallerStep).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(notifyTurnCallerStep).toHaveBeenCalledWith({
      caller,
      lifecycle: "parked",
      sessionId: "wrun_test_123",
      settled: { output: "settled answer" },
    });
  });

  it("keeps the turn caller across a callerless continuation", async () => {
    const sessionState = createBaseSessionState();
    const caller = {
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "parent-turn" },
      subagentName: "researcher",
    };
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    vi.mocked(resolveInitialTurnCallerStep).mockResolvedValueOnce(caller);
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [
            {
              kind: "send",
              payload: { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
            },
          ],
        },
      ],
      turnControls: [
        turnResult({ action: "park", sessionState }),
        turnResult({
          action: "park",
          sessionState,
          settled: { output: "approved answer" },
        }),
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "delegate" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "" });

    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller,
      lifecycle: "parked",
      sessionId: "wrun_test_123",
      settled: { output: "approved answer" },
    });
  });

  it("passes the resumed channel request id to the next turn", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [
            {
              requestId: "req_followup",
              kind: "send",
              payload: { message: "follow up" },
            },
          ],
        },
      ],
      turnControls: [
        turnResult({ action: "park", sessionState }),
        turnResult({ action: "done", output: "ok", sessionState }),
      ],
    });

    await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
    });

    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      auth: undefined,
      requestId: "req_followup",
      kind: "deliver",
      payloads: [{ message: "follow up" }],
    });
  });

  it("supplies a requested public delivery to the active turn inbox", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));

    let acceptForward: (() => void) | undefined;
    const forwarded = new Promise<void>((resolve) => {
      acceptForward = resolve;
    });
    vi.mocked(resumeHook).mockImplementation(async (token) => {
      if (token === "turn-inbox") acceptForward?.();
      return { runId: "turn-run" } as never;
    });

    let completionIndex = 0;
    vi.mocked(createHook).mockImplementation((options?: { readonly token?: string }) => {
      const token = options?.token ?? "";
      if (isTurnCompletionToken(token)) {
        return createMockHook<TurnControlPayload>({
          next: async () => {
            completionIndex += 1;
            if (completionIndex === 1) {
              return {
                done: false,
                value: {
                  continuationToken: "http:test",
                  inboxToken: "turn-inbox",
                  kind: "turn-delivery-request",
                  requestId: "delivery-1",
                },
              };
            }
            if (completionIndex === 2) {
              await forwarded;
              return {
                done: false,
                value: { kind: "turn-delivery-accepted", requestId: "delivery-1" },
              };
            }
            return {
              done: false,
              value: turnResult({ action: "done", output: "finished", sessionState }),
            };
          },
          token,
          values: [],
        }) as never;
      }
      if (token.endsWith(":auth")) {
        return createMockHook({ token, values: [] }) as never;
      }
      return createMockHook({
        token,
        values: [
          {
            kind: "send",
            payload: { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
          },
        ],
      }) as never;
    });

    const result = await workflowEntry({
      input: { message: "delegate" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "finished" });
    expect(dispatchTurnStep).toHaveBeenCalledTimes(1);
    expect(resumeHook).toHaveBeenCalledWith("turn-inbox", {
      delivery: {
        kind: "deliver",
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }],
      },
      kind: "driver-delivery",
      requestId: "delivery-1",
    });
  });

  it("preserves a public delivery when the active turn cancels its request", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));

    vi.mocked(createHook).mockImplementation((options?: { readonly token?: string }) => {
      const token = options?.token ?? "";
      if (token.endsWith(":turn-control:0")) {
        return createMockHook({
          token,
          values: [
            {
              continuationToken: "http:test",
              inboxToken: "turn-inbox",
              kind: "turn-delivery-request",
              requestId: "delivery-1",
            },
            { kind: "turn-delivery-cancelled", requestId: "delivery-1" },
            turnResult({ action: "park", sessionState }),
          ],
        }) as never;
      }
      if (token.endsWith(":turn-control:1")) {
        return createMockHook({
          token,
          values: [turnResult({ action: "done", output: "after delivery", sessionState })],
        }) as never;
      }
      if (token.endsWith(":auth")) {
        return createMockHook({ token, values: [] }) as never;
      }
      return createMockHook({
        token,
        values: [{ kind: "send", payload: { message: "not for the child" } }],
      }) as never;
    });

    const result = await workflowEntry({
      input: { message: "delegate" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "after delivery" });
    expect(dispatchTurnStep).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      auth: undefined,
      kind: "deliver",
      payloads: [{ message: "not for the child" }],
      requestId: undefined,
    });
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it("settles a cancelled turn in the driver and starts the next turn from the settled state", async () => {
    const sessionState = createBaseSessionState({
      snapshot: {
        session: {
          agent: { system: "" },
          continuationToken: "http:test",
          history: [],
          sessionId: "wrun_test_123",
          state: {
            "eve.harness.settledTurn": { output: "stale prior answer" },
          },
        },
        version: 1,
      },
    });
    const settledState = createBaseSessionState({
      emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "" },
    });
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    vi.mocked(settleCancelledTurnStep).mockResolvedValue({
      serializedContext: { "eve.sessionId": "wrun_test_123", settled: true },
      sessionState: settledState,
    });
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [{ kind: "send", payload: { message: "after cancel" } }],
        },
      ],
      turnControls: [
        {
          action: {
            cancelled: true,
            kind: "park",
            serializedContext: { "eve.sessionId": "wrun_test_123" },
            sessionState,
          },
          kind: "turn-result",
        },
        turnResult({ action: "done", output: "ok", sessionState: settledState }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "ok" });
    expect(settleCancelledTurnStep).toHaveBeenCalledExactlyOnceWith({
      parentWritable: expect.any(WritableStream),
      serializedContext: { "eve.sessionId": "wrun_test_123" },
      sessionState,
    });
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0]).toMatchObject({
      serializedContext: { settled: true },
      sessionState: settledState,
    });
    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: undefined,
      lifecycle: "terminal",
      sessionId: "wrun_test_123",
      settled: { output: "ok" },
    });
  });

  it("does not settle an ordinary park as cancelled", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [{ token: "http:test", values: [] }],
      turnControls: [turnResult({ action: "park", sessionState })],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "" });
    expect(settleCancelledTurnStep).not.toHaveBeenCalled();
  });

  it("routes every settled conversation turn without classifying the session", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      deliveryHooks: [{ token: "http:test", values: [] }],
      turnControls: [
        turnResult({
          action: "park",
          sessionState,
          settled: { output: "hello" },
        }),
      ],
    });
    const serializedContext = createSerializedContext();

    await expect(
      workflowEntry({
        input: { message: "hello" },
        serializedContext,
      }),
    ).resolves.toEqual({ output: "" });

    expect(notifyTurnCallerStep).toHaveBeenCalledWith({
      caller: undefined,
      lifecycle: "parked",
      sessionId: "wrun_test_123",
      settled: { output: "hello" },
    });
  });

  it("does not re-send a settled parent turn when a delivery routes to a child", async () => {
    const sessionState = createBaseSessionState({ hasProxyInputRequests: true });
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    vi.mocked(routeDeliverToChildren).mockResolvedValueOnce({
      kind: "continue",
      remainder: undefined,
    });
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [{ kind: "send", payload: { inputResponses: [] } }],
        },
      ],
      turnControls: [
        turnResult({
          action: "park",
          sessionState,
          settled: { output: "already sent" },
        }),
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "hello" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "" });

    expect(notifyTurnCallerStep).toHaveBeenCalledTimes(1);
  });

  it("runs concurrent caller deliveries as separate turns", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    const firstCaller = {
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "caller-1" },
      subagentName: "researcher",
    };
    const secondCaller = {
      callId: "call-2",
      replyTo: { kind: "hook" as const, token: "caller-2" },
      subagentName: "researcher",
    };
    installHookMocks({
      deliveryHooks: [
        {
          token: "http:test",
          values: [],
        },
      ],
      turnControls: [
        {
          action: {
            kind: "park",
            serializedContext: { "eve.sessionId": "wrun_test_123" },
            sessionState,
          },
          bufferedDeliveries: [
            {
              caller: firstCaller,
              kind: "deliver",
              payloads: [{ message: "first question" }],
            },
            {
              caller: secondCaller,
              kind: "deliver",
              payloads: [{ message: "second question" }],
            },
          ],
          kind: "turn-result",
        },
        turnResult({
          action: "park",
          sessionState,
          settled: { output: "first answer" },
        }),
        turnResult({
          action: "park",
          sessionState,
          settled: { output: "second answer" },
        }),
      ],
    });

    await expect(
      workflowEntry({
        input: { message: "initial question" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "" });

    expect(dispatchTurnStep).toHaveBeenCalledTimes(3);
    expect(notifyTurnCallerStep).toHaveBeenNthCalledWith(1, {
      caller: firstCaller,
      lifecycle: "parked",
      sessionId: "wrun_test_123",
      settled: { output: "first answer" },
    });
    expect(notifyTurnCallerStep).toHaveBeenNthCalledWith(2, {
      caller: secondCaller,
      lifecycle: "parked",
      sessionId: "wrun_test_123",
      settled: { output: "second answer" },
    });
  });

  it("skips child routing when a turn completes without yielding to a delivery", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      turnControls: [
        turnResult({
          action: "done",
          output: "ok",
          serializedContext: { "eve.sessionId": "wrun_test_123" },
          sessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "ok" });
    expect(routeDeliverToChildren).not.toHaveBeenCalled();
  });

  it("parks the first hook under the re-keyed continuation token", async () => {
    const baseSessionState = createBaseSessionState({ continuationToken: "slack:C01:" });
    const rekeyedSessionState: DurableSessionState = {
      ...baseSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );

    const initialReturn = createIteratorReturn();
    const initialDispose = vi.fn();
    const rekeyedReturn = createIteratorReturn();
    const rekeyedDispose = vi.fn();
    installHookMocks({
      deliveryHooks: [
        {
          dispose: initialDispose,
          return: initialReturn,
          token: "slack:C01:",
          values: [],
        },
        {
          dispose: rekeyedDispose,
          return: rekeyedReturn,
          token: "slack:C01:1800000000.123456",
          values: [],
        },
      ],
      turnControls: [turnResult({ action: "park", sessionState: rekeyedSessionState })],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext({
        "eve.channel": { kind: "slack", state: {} },
        "eve.continuationToken": "slack:C01:",
      }),
    });

    expect(result).toEqual({ output: "" });
    // Initial hook created before the turn, then rekeyed after.
    expect(nonTurnHookTokens()).toEqual(["slack:C01:", "slack:C01:1800000000.123456"]);
    expect(initialReturn).not.toHaveBeenCalled();
    expect(initialDispose).toHaveBeenCalledTimes(1);
    expect(rekeyedReturn).not.toHaveBeenCalled();
    expect(rekeyedDispose).toHaveBeenCalledTimes(1);
  });

  it("defers the first delivery hook until an empty continuation token is anchored", async () => {
    const baseSessionState = createBaseSessionState({ continuationToken: "" });
    const anchoredSessionState: DurableSessionState = {
      ...baseSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );

    const anchoredReturn = createIteratorReturn();
    const anchoredDispose = vi.fn();
    installHookMocks({
      deliveryHooks: [
        {
          dispose: anchoredDispose,
          return: anchoredReturn,
          token: "slack:C01:1800000000.123456",
          values: [],
        },
      ],
      turnControls: [turnResult({ action: "park", sessionState: anchoredSessionState })],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext({
        "eve.channel": { kind: "slack", state: {} },
        "eve.continuationToken": "",
      }),
    });

    expect(result).toEqual({ output: "" });
    expect(nonTurnHookTokens()).toEqual(["slack:C01:1800000000.123456"]);
    expect(anchoredReturn).not.toHaveBeenCalled();
    expect(anchoredDispose).toHaveBeenCalledTimes(1);
  });

  it("recreates the delivery hook when a later turn re-keys the session", async () => {
    const baseSessionState = createBaseSessionState({ continuationToken: "slack:C01:" });
    const rekeyedSessionState: DurableSessionState = {
      ...baseSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );

    const oldReturn = createIteratorReturn();
    const oldDispose = vi.fn();
    const oldGetConflict = vi.fn(async () => null);
    const newReturn = createIteratorReturn();
    const newDispose = vi.fn();
    const newGetConflict = vi.fn(async () => null);
    installHookMocks({
      deliveryHooks: [
        {
          dispose: oldDispose,
          getConflict: oldGetConflict,
          return: oldReturn,
          token: "slack:C01:",
          values: [
            {
              kind: "send",
              payload: { message: "follow up" },
            },
          ],
        },
        {
          dispose: newDispose,
          getConflict: newGetConflict,
          return: newReturn,
          token: "slack:C01:1800000000.123456",
          values: [],
        },
      ],
      turnControls: [
        turnResult({ action: "park", sessionState: baseSessionState }),
        turnResult({ action: "park", sessionState: rekeyedSessionState }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext({
        "eve.channel": { kind: "slack", state: {} },
        "eve.continuationToken": "slack:C01:",
      }),
    });

    expect(result).toEqual({ output: "" });
    expect(nonTurnHookTokens()).toEqual(["slack:C01:", "slack:C01:1800000000.123456"]);
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      kind: "deliver",
      payloads: [{ message: "follow up" }],
    });
    expect(oldReturn).not.toHaveBeenCalled();
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(newReturn).not.toHaveBeenCalled();
    expect(newDispose).toHaveBeenCalledTimes(1);
    expect(oldGetConflict).toHaveBeenCalledOnce();
    expect(newGetConflict).toHaveBeenCalledOnce();
    expect(newGetConflict.mock.invocationCallOrder[0]).toBeLessThan(
      oldDispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("disposes the workflow hook after the loop exits", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));

    const dispose = vi.fn();
    const symbolDispose = vi.fn();
    const returnIterator = createIteratorReturn();
    installHookMocks({
      deliveryHooks: [
        {
          dispose,
          return: returnIterator,
          token: "http:test",
          values: [
            {
              kind: "send",
              payload: { message: "follow up" },
            },
          ],
        },
      ],
      symbolDispose,
      turnControls: [
        turnResult({ action: "park", sessionState }),
        turnResult({ action: "done", output: "after resume", sessionState }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "after resume" });
    expect(returnIterator).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(symbolDispose).not.toHaveBeenCalled();
  });

  it("disposes the auth hook without closing its iterator", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));

    const authDispose = vi.fn();
    const authReturn = createIteratorReturn();
    installHookMocks({
      authHook: { dispose: authDispose, return: authReturn },
      turnControls: [turnResult({ action: "done", output: "ok", sessionState })],
    });

    await expect(
      workflowEntry({
        input: { message: "hello" },
        serializedContext: createSerializedContext(),
      }),
    ).resolves.toEqual({ output: "ok" });

    expect(authDispose).toHaveBeenCalledOnce();
    expect(authReturn).not.toHaveBeenCalled();
  });
});

function createSerializedContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: {} },
    "eve.channel": { kind: "http", state: {} },
    "eve.continuationToken": "http:test",
    "eve.mode": "conversation",
    ...overrides,
  };
}

function createBaseSessionState(overrides: Partial<DurableSessionState> = {}): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "wrun_test_123",
    version: 1,
    ...overrides,
  };
}

function turnResult(input: {
  readonly action: "done" | "park";
  readonly output?: string;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly settled?: {
    readonly output: unknown;
    readonly isError?: boolean;
  };
}): TurnControlPayload {
  const serializedContext = input.serializedContext ?? { "eve.sessionId": "wrun_test_123" };
  if (input.action === "done") {
    return {
      action: {
        kind: "done",
        output: input.output ?? "",
        serializedContext,
        sessionState: input.sessionState,
      },
      kind: "turn-result",
    };
  }
  const park = {
    kind: "park" as const,
    serializedContext,
    sessionState: input.sessionState,
  };
  return {
    action: input.settled === undefined ? park : { ...park, settled: input.settled },
    kind: "turn-result",
  };
}

function installHookMocks(input: {
  readonly authHook?: AuthHookConfig;
  readonly deliveryHooks?: readonly DeliveryHookConfig[];
  readonly stableHook?: Omit<DeliveryHookConfig, "token">;
  readonly symbolDispose?: () => void;
  readonly turnControls: readonly TurnControlPayload[];
}): void {
  const turnControls = [...input.turnControls];
  const deliveryHooks = [...(input.deliveryHooks ?? [])];

  vi.mocked(createHook).mockImplementation((options?: { readonly token?: string }) => {
    const token = options?.token;

    if (token === undefined || isTurnCompletionToken(token)) {
      const value = turnControls.shift();
      return createMockHook({
        token: token ?? "turn-control",
        values: value === undefined ? [] : [value],
      }) as never;
    }

    if (token.endsWith(":auth")) {
      return createMockHook({
        dispose: input.authHook?.dispose,
        return: input.authHook?.return,
        token,
        values: [],
      }) as never;
    }

    if (token === sessionCommandHookToken("wrun_test_123")) {
      const values = [...(input.stableHook?.values ?? [])];
      return createMockHook({
        dispose: input.stableHook?.dispose,
        getConflict: input.stableHook?.getConflict,
        next:
          input.stableHook?.next ??
          (async () => {
            const value = values.shift();
            return value === undefined
              ? await new Promise<IteratorResult<SessionInboxPayload>>(() => {})
              : { done: false, value };
          }),
        return: input.stableHook?.return,
        token,
        values: [],
      }) as never;
    }

    const config = deliveryHooks.shift() ?? { token, values: [] };
    if (config.token !== token) {
      throw new Error(`Expected delivery hook token "${config.token}", received "${token}".`);
    }

    return createMockHook({
      dispose: config.dispose,
      getConflict: config.getConflict,
      next: config.next,
      return: config.return,
      symbolDispose: input.symbolDispose,
      token,
      values: config.values ?? [],
    }) as never;
  });
}

function createTimeoutControl(): SessionTimeoutControl {
  return {
    dispose: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
  };
}

function createMockHook<T>(input: {
  readonly dispose?: () => void;
  readonly getConflict?: () => Promise<{ readonly runId: string } | null>;
  readonly next?: () => Promise<IteratorResult<T>>;
  readonly return?: () => Promise<IteratorResult<T>>;
  readonly symbolDispose?: () => void;
  readonly token: string;
  readonly values: readonly T[];
}): unknown {
  const values = [...input.values];
  const dispose = input.dispose ?? vi.fn();
  const getConflict = input.getConflict ?? vi.fn(async () => null);
  const symbolDispose = input.symbolDispose ?? vi.fn();
  const iteratorReturn = input.return;

  return Object.assign(Promise.resolve(undefined), {
    [Symbol.asyncIterator]() {
      return {
        next:
          input.next ??
          async function next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value === undefined) {
              return { done: true, value: undefined };
            }
            return { done: false, value };
          },
        return: iteratorReturn,
      };
    },
    [Symbol.dispose]: symbolDispose,
    dispose,
    getConflict,
    token: input.token,
  });
}

function createIteratorReturn(): () => Promise<IteratorResult<never>> {
  return vi.fn(
    async (): Promise<IteratorResult<never>> => ({
      done: true,
      value: undefined,
    }),
  );
}

function nonTurnHookTokens(): string[] {
  return vi
    .mocked(createHook)
    .mock.calls.map((call) => call[0]?.token)
    .filter(
      (token): token is string =>
        token !== undefined &&
        token !== sessionCommandHookToken("wrun_test_123") &&
        !token.endsWith(":auth") &&
        !isTurnCompletionToken(token),
    );
}

function isTurnCompletionToken(token: string): boolean {
  return /:turn-control:\d+$/.test(token);
}
