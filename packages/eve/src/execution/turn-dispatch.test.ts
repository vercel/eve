import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import type { SessionInputQueue } from "#execution/session-input-queue.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

vi.mock("./workflow-steps.js", () => ({
  dispatchTurnStep: vi.fn(async () => ({ runId: "turn-run" })),
}));

vi.mock("./forward-turn-delivery-step.js", () => ({
  forwardTurnDeliveryStep: vi.fn(),
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
    const deliveryHook = createDeliveryHook({ rekey: rekeyHook });

    await dispatchAndAwaitTurn({
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      inputQueue: createInputQueue([], deliveryHook),
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
    const deliveryHook = createDeliveryHook({ rekey: rekeyHook });

    await dispatchAndAwaitTurn({
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      inputQueue: createInputQueue([], deliveryHook),
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
    const deliveryHook = createDeliveryHook({
      next: async () => ({
        done: false,
        value: { kind: "deliver", payloads: [{ message: "later delivery" }] },
      }),
    });
    await dispatchAndAwaitTurn({
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      inputQueue: createInputQueue(bufferedDeliveries, deliveryHook),
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state,
    });

    expect(bufferedDeliveries.map((item) => item.payloads[0]?.message)).toEqual([
      "earlier remainder",
      "later delivery",
    ]);
  });

  it("re-buffers a forwarded delivery when the turn inbox is already gone", async () => {
    const state = createState("http:test");
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "request-1", text: "relayed" }] }],
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
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      inputQueue: createInputQueue(bufferedDeliveries, createDeliveryHook()),
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
      controlToken: "turn-control",
      delivery: { kind: "deliver", payloads: [{ message: "start" }] },
      inputQueue: createInputQueue([], createDeliveryHook()),
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
});

function createDeliveryHook(overrides: Partial<SessionDeliveryHook> = {}): SessionDeliveryHook {
  return {
    consumeNext: vi.fn(),
    next: vi.fn(() => new Promise<IteratorResult<HookPayload>>(() => {})),
    rekey: vi.fn(),
    ...overrides,
  };
}

function createInputQueue(
  buffered: DeliverHookPayload[],
  deliveryHook: SessionDeliveryHook,
): SessionInputQueue {
  return {
    appendQueued(delivery): void {
      buffered.push(delivery);
    },
    consumeAdmission: () => deliveryHook.consumeNext(),
    dispose: vi.fn(),
    nextAdmission: () => deliveryHook.next(),
    prependReturned(delivery): void {
      buffered.unshift(delivery);
    },
    prependTurnRemainders(deliveries): void {
      buffered.unshift(...deliveries);
    },
    rekey: (token) => deliveryHook.rekey(token),
    returnSteering(delivery): void {
      buffered.push({ ...delivery, turnPolicy: "queue" });
    },
    takeExplicitResponse(): DeliverHookPayload | undefined {
      const index = buffered.findIndex((delivery) =>
        delivery.payloads.some((payload) => (payload.inputResponses?.length ?? 0) > 0),
      );
      return index < 0 ? undefined : buffered.splice(index, 1)[0];
    },
    takeNextTurn: vi.fn(async () => null),
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
