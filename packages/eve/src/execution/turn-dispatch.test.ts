import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { dispatchTurnStep } from "#execution/dispatch-turn-step.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import type { SessionCommandInbox, SessionInboxPayload } from "#execution/session-command-inbox.js";
import { createSessionCommandRouter } from "#execution/session-command-router.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { turnStep } from "#execution/workflow-steps.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

vi.mock("./dispatch-turn-step.js", () => ({
  dispatchTurnStep: vi.fn(async () => ({ runId: "turn-run" })),
}));

vi.mock("./forward-turn-delivery-step.js", () => ({
  forwardTurnDeliveryStep: vi.fn(),
}));

vi.mock("./workflow-steps.js", () => ({
  turnStep: vi.fn(),
}));

describe("dispatchAndAwaitTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createHookMock.mockReset();
  });

  it("rekeys the public hook when the active turn changes its continuation token", async () => {
    const state = createState("slack:C1:T1");
    installControlHook([
      { continuationToken: "slack:C1:T1", kind: "turn-continuation-token" },
      {
        action: { kind: "park", serializedContext: {}, sessionState: state },
        kind: "turn-result",
      },
    ]);
    const rekeyHook = vi.fn();
    const commandInbox = createCommandInbox({ rekeyContinuation: rekeyHook });

    await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox,
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: createState("slack:C1:"),
    });

    expect(rekeyHook).toHaveBeenCalledWith("slack:C1:T1");
  });

  it("rekeys while a turn delivery request is already waiting", async () => {
    const state = createState("slack:C1:T1");
    installControlHook([
      {
        continuationToken: "slack:C1:",
        inboxToken: "turn-inbox",
        kind: "turn-delivery-request",
        requestId: "request-1",
      },
      { continuationToken: "slack:C1:T1", kind: "turn-continuation-token" },
      { kind: "turn-delivery-cancelled", requestId: "request-1" },
      {
        action: { kind: "park", serializedContext: {}, sessionState: state },
        kind: "turn-result",
      },
    ]);
    const rekeyHook = vi.fn();
    const commandInbox = createCommandInbox({ rekeyContinuation: rekeyHook });

    await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox,
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: createState("slack:C1:"),
    });

    expect(rekeyHook).toHaveBeenCalledWith("slack:C1:T1");
  });

  it("keeps earlier turn remainders ahead of later cancelled deliveries", async () => {
    const state = createState("http:test");
    let releaseCancellation: (() => void) | undefined;
    const forwarded = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    vi.mocked(forwardTurnDeliveryStep).mockImplementation(async () => releaseCancellation?.());

    let controlIndex = 0;
    createHookMock.mockReturnValue(
      createMockHook(async () => {
        controlIndex += 1;
        if (controlIndex === 1) {
          return {
            done: false,
            value: {
              continuationToken: "http:test",
              inboxToken: "turn-inbox",
              kind: "turn-delivery-request",
              requestId: "request-1",
            },
          };
        }
        if (controlIndex === 2) {
          await forwarded;
          return {
            done: false,
            value: { kind: "turn-delivery-cancelled", requestId: "request-1" },
          };
        }
        return {
          done: false,
          value: {
            action: { kind: "park", serializedContext: {}, sessionState: state },
            bufferedDeliveries: [{ kind: "deliver", payloads: [{ message: "earlier remainder" }] }],
            kind: "turn-result",
          },
        };
      }),
    );

    const bufferedDeliveries: DeliverHookPayload[] = [];
    await dispatchAndAwaitTurn({
      bufferedDeliveries,
      bufferedSessionControls: [],
      commandInbox: createCommandInbox({
        next: async () => ({
          done: false,
          value: {
            kind: "send",
            payload: { inputResponses: [{ optionId: "yes", requestId: "input-1" }] },
          },
        }),
      }),
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state,
    });

    expect(bufferedDeliveries).toEqual([
      { kind: "deliver", payloads: [{ message: "earlier remainder" }] },
      expect.objectContaining({
        payloads: [{ inputResponses: [{ optionId: "yes", requestId: "input-1" }] }],
      }),
    ]);
  });

  it("re-buffers a forwarded delivery when the turn inbox is already gone", async () => {
    const state = createState("http:test");
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "yes", requestId: "input-1" }] }],
    };
    vi.mocked(forwardTurnDeliveryStep).mockRejectedValue(
      Object.assign(new Error("inbox gone"), { name: "HookNotFoundError" }),
    );
    installControlHook([
      {
        continuationToken: "http:test",
        inboxToken: "turn-inbox",
        kind: "turn-delivery-request",
        requestId: "request-1",
      },
      {
        action: { kind: "park", serializedContext: {}, sessionState: state },
        kind: "turn-result",
      },
    ]);

    const bufferedDeliveries: DeliverHookPayload[] = [delivery];
    const turn = await dispatchAndAwaitTurn({
      bufferedDeliveries,
      bufferedSessionControls: [],
      commandInbox: createCommandInbox(),
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state,
    });

    expect(forwardTurnDeliveryStep).toHaveBeenCalledOnce();
    expect(turn.action.kind).toBe("park");
    expect(bufferedDeliveries).toEqual([delivery]);
  });

  it("defers control-hook disposal until the caller invokes dispose()", async () => {
    const state = createState("http:test");
    installControlHook([
      {
        action: { kind: "park", serializedContext: {}, sessionState: state },
        kind: "turn-result",
      },
    ]);

    const turn = await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox: createCommandInbox(),
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state,
    });

    // The turn run's final control send is at-least-once; a late
    // duplicate resume must land on a live hook (see DispatchedTurn).
    const hook = createHookMock.mock.results[0]?.value as { dispose: ReturnType<typeof vi.fn> };
    expect(hook.dispose).not.toHaveBeenCalled();
    await turn.dispose();
    expect(hook.dispose).toHaveBeenCalledOnce();
  });

  it("settles an ordinary same-deployment turn without a child workflow", async () => {
    const state = createState("http:test");
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      serializedContext: { state: "settled" },
      sessionState: state,
      settled: { output: "ok" },
    });

    const turn = await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox: createCommandInbox(),
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: createAcceptedDelivery(),
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { state: "start" },
      sessionState: state,
    });

    expect(turn.action).toMatchObject({ kind: "park", settled: { output: "ok" } });
    expect(turnStep).toHaveBeenCalledWith(
      expect.objectContaining({ acceptedDeploymentId: "dpl_current" }),
    );
    expect(dispatchTurnStep).not.toHaveBeenCalled();
    expect(createHookMock).not.toHaveBeenCalled();
  });

  it("keeps ordinary tool-loop continuations inline", async () => {
    const firstState = createState("http:test:rekeyed");
    const finalState = createState("http:test:rekeyed");
    vi.mocked(turnStep)
      .mockResolvedValueOnce({
        action: "continue",
        serializedContext: { state: "continued" },
        sessionState: firstState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "complete",
        serializedContext: { state: "done" },
        sessionState: finalState,
      });
    const commandInbox = createCommandInbox();

    const turn = await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox,
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: createAcceptedDelivery(),
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { state: "start" },
      sessionState: createState("http:test"),
    });

    expect(turn.action).toMatchObject({ kind: "done", output: "complete" });
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toBeUndefined();
    expect(commandInbox.rekeyContinuation).toHaveBeenCalledWith("http:test:rekeyed");
    expect(dispatchTurnStep).not.toHaveBeenCalled();
  });

  it("hands an already-completed complex step to the child workflow", async () => {
    const state = createState("http:test");
    const result = {
      action: "park" as const,
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      pendingCoordinationCallIds: ["call-1"],
      serializedContext: { state: "pending" },
      sessionState: state,
    };
    vi.mocked(turnStep).mockResolvedValueOnce(result);
    installControlHook([
      {
        action: { kind: "park", serializedContext: result.serializedContext, sessionState: state },
        kind: "turn-result",
      },
    ]);

    await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox: createCommandInbox(),
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: createAcceptedDelivery(),
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { state: "start" },
      sessionState: state,
    });

    expect(dispatchTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({
        initialStep: {
          beforeStep: expect.objectContaining({ serializedContext: { state: "start" } }),
          result,
        },
      }),
    );
  });

  it("defers a guarded deployment mismatch without consuming the delivery", async () => {
    const state = createState("http:test");
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "continue",
      requiresChildDispatch: true,
      serializedContext: { state: "start" },
      sessionState: state,
    });
    installControlHook([
      {
        action: { kind: "park", serializedContext: {}, sessionState: state },
        kind: "turn-result",
      },
    ]);

    await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox: createCommandInbox(),
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: createAcceptedDelivery(),
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { state: "start" },
      sessionState: state,
    });

    expect(dispatchTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ initialStep: undefined }),
    );
  });

  it("carries inline cancellation into the continued child turn", async () => {
    const state = createState("http:test");
    vi.mocked(turnStep).mockImplementationOnce(async (input) => {
      await vi.waitFor(() => expect(input.abortSignal?.aborted).toBe(true));
      return {
        action: "cancelled",
        serializedContext: { state: "cancelled" },
        sessionState: state,
      };
    });
    let delivered = false;
    const commandInbox = createCommandInbox({
      next: vi.fn(async () => {
        if (!delivered) {
          delivered = true;
          return { done: false as const, value: { kind: "cancel" as const } };
        }
        return await new Promise<IteratorResult<SessionInboxPayload>>(() => {});
      }),
    });
    installControlHook([
      {
        action: { cancelled: true, kind: "park", serializedContext: {}, sessionState: state },
        kind: "turn-result",
      },
    ]);

    await dispatchAndAwaitTurn({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox,
      commandRouter: createSessionCommandRouter(),
      controlToken: "turn-control",
      delivery: createAcceptedDelivery(),
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { state: "start" },
      sessionState: state,
    });

    expect(dispatchTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({
        initialCancellation: {},
        initialStep: expect.objectContaining({
          result: expect.objectContaining({ action: "cancelled" }),
        }),
      }),
    );
    expect(commandInbox.consumeNext).toHaveBeenCalledOnce();
  });
});

function createCommandInbox(overrides: Partial<SessionCommandInbox> = {}): SessionCommandInbox {
  return {
    claimAuthorization: vi.fn(),
    claimStable: vi.fn(),
    consumeNext: vi.fn(),
    hasReadyAuthorization: vi.fn(() => false),
    next: vi.fn(() => new Promise<IteratorResult<SessionInboxPayload>>(() => {})),
    nextWithSource: vi.fn(() =>
      Promise.reject(new Error("nextWithSource is not modeled by this test inbox.")),
    ),
    rekeyContinuation: vi.fn(),
    setAuthorizationWindow: vi.fn(),
    ...overrides,
  };
}

function installControlHook(values: readonly TurnControlPayload[]): void {
  const queue = [...values];
  createHookMock.mockReturnValue(
    createMockHook(async () => {
      const value = queue.shift();
      return value === undefined ? { done: true, value: undefined } : { done: false, value };
    }),
  );
}

function createMockHook(next: () => Promise<IteratorResult<TurnControlPayload>>): unknown {
  return {
    token: "turn-control",
    dispose: vi.fn(),
    [Symbol.asyncIterator]() {
      return {
        next,
        return: vi.fn(async () => ({ done: true, value: undefined })),
      };
    },
  };
}

function createState(continuationToken: string): DurableSessionState {
  return {
    continuationToken,
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "session",
    version: 1,
  };
}

function createAcceptedDelivery(): DeliverHookPayload {
  return {
    deliveryMetadata: [
      {
        acceptedDeploymentId: "dpl_current",
        channelKind: "channel:test",
        channelName: "test",
        deliveryId: "delivery-1",
        payloadIndex: 0,
      },
    ],
    kind: "deliver",
    payloads: [{ message: "start" }],
  };
}
