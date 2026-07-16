import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import { forwardTurnSteeringStep } from "#execution/forward-turn-steering-step.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import type { SessionInputQueue } from "#execution/session-input-queue.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

vi.mock("./forward-turn-delivery-step.js", () => ({
  forwardTurnDeliveryStep: vi.fn(),
}));

vi.mock("./forward-turn-steering-step.js", () => ({
  forwardTurnSteeringStep: vi.fn(),
}));

describe("TurnControlReceiver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createHookMock.mockReset();
  });

  it("forwards a buffered delivery and consumes it once the turn accepts", async () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "req-1", text: "hello" }] }],
    };
    installControlHook([
      deliveryRequest("req-1"),
      { kind: "turn-delivery-accepted", requestId: "req-1" },
      parkResult(),
    ]);
    const bufferedDeliveries: DeliverHookPayload[] = [delivery];

    const action = await runReceiver(bufferedDeliveries);

    expect(forwardTurnDeliveryStep).toHaveBeenCalledWith({
      inboxToken: "turn-inbox",
      payload: { delivery, kind: "driver-delivery", requestId: "req-1" },
    });
    expect(action.kind).toBe("park");
    expect(bufferedDeliveries).toEqual([]);
  });

  it("re-buffers the outstanding delivery when the turn cancels its request", async () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "req-1", text: "hello" }] }],
    };
    installControlHook([
      deliveryRequest("req-1"),
      { kind: "turn-delivery-cancelled", requestId: "req-1" },
      parkResult(),
    ]);
    const bufferedDeliveries: DeliverHookPayload[] = [delivery];

    const action = await runReceiver(bufferedDeliveries);

    expect(forwardTurnDeliveryStep).toHaveBeenCalledOnce();
    expect(action.kind).toBe("park");
    expect(bufferedDeliveries).toEqual([delivery]);
  });

  it("re-buffers an unresolved forwarded delivery when the turn terminates", async () => {
    const delivery: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "hello" }] };
    installControlHook([
      deliveryRequest("req-1"),
      {
        action: { kind: "done", output: "bye", serializedContext: {}, sessionState: createState() },
        kind: "turn-result",
      },
    ]);
    const bufferedDeliveries: DeliverHookPayload[] = [delivery];

    const action = await runReceiver(bufferedDeliveries);

    expect(action).toMatchObject({ kind: "done", output: "bye" });
    expect(bufferedDeliveries).toEqual([delivery]);
  });

  it("hands the turn's remainders back ahead of existing buffered deliveries", async () => {
    const earlier: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "earlier" }] };
    const handBack: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "from-turn" }] };
    installControlHook([{ ...parkResult(), bufferedDeliveries: [handBack] }]);
    const bufferedDeliveries: DeliverHookPayload[] = [earlier];

    await runReceiver(bufferedDeliveries);

    expect(bufferedDeliveries.map((item) => item.payloads[0]?.message)).toEqual([
      "from-turn",
      "earlier",
    ]);
  });

  it("rethrows a rebuilt error when the turn reports a failure", async () => {
    installControlHook([{ error: { message: "boom", name: "TurnError" }, kind: "turn-error" }]);

    await expect(runReceiver([])).rejects.toThrow("boom");
  });

  it("forwards steer input to the active turn and consumes it after acknowledgement", async () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "change course" }],
      turnPolicy: "steer",
    };
    let acknowledge: (() => void) | undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    installControlHookFactory([
      async () => ({
        done: false,
        value: { kind: "turn-steering-ready", steeringToken: "turn-steer" },
      }),
      async () => {
        await acknowledgement;
        return {
          done: false,
          value: { kind: "turn-steering-accepted", requestId: "turn-control:steer:0" },
        };
      },
      async () => ({ done: false, value: parkResult() }),
    ]);
    vi.mocked(forwardTurnSteeringStep).mockImplementationOnce(async () => acknowledge?.());
    const consumeNext = vi.fn();
    const deliveryHook = createDeliveryHook({
      consumeNext,
      next: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: delivery })
        .mockImplementation(() => new Promise(() => {})),
    });

    const action = await runReceiver([], deliveryHook);

    expect(forwardTurnSteeringStep).toHaveBeenCalledWith({
      payload: { delivery, requestId: "turn-control:steer:0" },
      steeringToken: "turn-steer",
    });
    expect(consumeNext).toHaveBeenCalledOnce();
    expect(action.kind).toBe("park");
  });

  it("returns unacknowledged steering to the queue when the turn terminates", async () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "change course" }],
      turnPolicy: "steer",
    };
    let finish: (() => void) | undefined;
    const forwarded = new Promise<void>((resolve) => {
      finish = resolve;
    });
    installControlHookFactory([
      async () => ({
        done: false,
        value: { kind: "turn-steering-ready", steeringToken: "turn-steer" },
      }),
      async () => {
        await forwarded;
        return { done: false, value: parkResult() };
      },
    ]);
    vi.mocked(forwardTurnSteeringStep).mockImplementationOnce(async () => finish?.());
    const deliveryHook = createDeliveryHook({
      next: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: delivery })
        .mockImplementation(() => new Promise(() => {})),
    });
    const buffered: DeliverHookPayload[] = [];

    await runReceiver(buffered, deliveryHook);

    expect(buffered).toEqual([{ ...delivery, turnPolicy: "queue" }]);
  });

  it("keeps steering outstanding across a mismatched acknowledgement", async () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "change course" }],
      turnPolicy: "steer",
    };
    let acknowledge: (() => void) | undefined;
    const forwarded = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    installControlHookFactory([
      async () => ({
        done: false,
        value: { kind: "turn-steering-ready", steeringToken: "turn-steer" },
      }),
      async () => {
        await forwarded;
        return {
          done: false,
          value: { kind: "turn-steering-accepted", requestId: "stale-request" },
        };
      },
      async () => ({
        done: false,
        value: { kind: "turn-steering-accepted", requestId: "turn-control:steer:0" },
      }),
      async () => ({ done: false, value: parkResult() }),
    ]);
    vi.mocked(forwardTurnSteeringStep).mockImplementationOnce(async () => acknowledge?.());
    const deliveryHook = createDeliveryHook({
      next: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: delivery })
        .mockImplementation(() => new Promise(() => {})),
    });
    const buffered: DeliverHookPayload[] = [];

    await runReceiver(buffered, deliveryHook);

    expect(buffered).toEqual([]);
  });

  it("keeps a delivery request active while forwarding steer input", async () => {
    const steeringDelivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "change course" }],
      turnPolicy: "steer",
    };
    const requestDelivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "approval response" }],
    };
    let acknowledgeSteering: (() => void) | undefined;
    const steeringAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeSteering = resolve;
    });
    let acknowledgeRequest: (() => void) | undefined;
    const requestAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeRequest = resolve;
    });
    installControlHookFactory([
      async () => ({
        done: false,
        value: { kind: "turn-steering-ready", steeringToken: "turn-steer" },
      }),
      async () => ({ done: false, value: deliveryRequest("req-1") }),
      async () => {
        await steeringAcknowledgement;
        return {
          done: false,
          value: { kind: "turn-steering-accepted", requestId: "turn-control:steer:0" },
        };
      },
      async () => {
        await requestAcknowledgement;
        return {
          done: false,
          value: { kind: "turn-delivery-accepted", requestId: "req-1" },
        };
      },
      async () => ({ done: false, value: parkResult() }),
    ]);
    vi.mocked(forwardTurnSteeringStep).mockImplementationOnce(async () => acknowledgeSteering?.());
    vi.mocked(forwardTurnDeliveryStep).mockImplementationOnce(async () => acknowledgeRequest?.());
    const consumeNext = vi.fn();
    const deliveryHook = createDeliveryHook({
      consumeNext,
      next: vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ done: false, value: steeringDelivery })
        .mockResolvedValueOnce({ done: false, value: requestDelivery })
        .mockImplementation(() => new Promise(() => {})),
    });

    const action = await runReceiver([], deliveryHook);

    expect(forwardTurnSteeringStep).toHaveBeenCalledWith({
      payload: { delivery: steeringDelivery, requestId: "turn-control:steer:0" },
      steeringToken: "turn-steer",
    });
    expect(forwardTurnDeliveryStep).toHaveBeenCalledOnce();
    expect(forwardTurnDeliveryStep).toHaveBeenCalledWith({
      inboxToken: "turn-inbox",
      payload: { delivery: requestDelivery, kind: "driver-delivery", requestId: "req-1" },
    });
    expect(consumeNext).toHaveBeenCalledTimes(2);
    expect(action.kind).toBe("park");
  });

  it("services a buffered response after an outstanding steer is accepted", async () => {
    const steeringDelivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "change course" }],
      turnPolicy: "steer",
    };
    const response: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "req-1", text: "approved" }] }],
    };
    let steeringForwarded: (() => void) | undefined;
    const forwardedSteering = new Promise<void>((resolve) => {
      steeringForwarded = resolve;
    });
    let responseForwarded: (() => void) | undefined;
    const forwardedResponse = new Promise<void>((resolve) => {
      responseForwarded = resolve;
    });
    installControlHookFactory([
      async () => ({
        done: false,
        value: { kind: "turn-steering-ready", steeringToken: "turn-steer" },
      }),
      async () => {
        await forwardedSteering;
        return { done: false, value: deliveryRequest("req-1") };
      },
      async () => ({
        done: false,
        value: { kind: "turn-steering-accepted", requestId: "turn-control:steer:0" },
      }),
      async () => {
        await forwardedResponse;
        return {
          done: false,
          value: { kind: "turn-delivery-accepted", requestId: "req-1" },
        };
      },
      async () => ({ done: false, value: parkResult() }),
    ]);
    vi.mocked(forwardTurnSteeringStep).mockImplementationOnce(async () => steeringForwarded?.());
    vi.mocked(forwardTurnDeliveryStep).mockImplementationOnce(async () => responseForwarded?.());
    const deliveryHook = createDeliveryHook({
      next: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: steeringDelivery })
        .mockImplementation(() => new Promise(() => {})),
    });
    const buffered = [response];

    await runReceiver(buffered, deliveryHook);

    expect(forwardTurnDeliveryStep).toHaveBeenCalledWith({
      inboxToken: "turn-inbox",
      payload: { delivery: response, kind: "driver-delivery", requestId: "req-1" },
    });
    expect(buffered).toEqual([]);
  });

  it("buffers queue input while the active turn continues", async () => {
    const delivery: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "later" }],
      turnPolicy: "queue",
    };
    let finish: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    installControlHookFactory([
      async () => ({
        done: false,
        value: { kind: "turn-steering-ready", steeringToken: "turn-steer" },
      }),
      async () => {
        await finished;
        return { done: false, value: parkResult() };
      },
    ]);
    const consumeNext = vi.fn(() => finish?.());
    const deliveryHook = createDeliveryHook({
      consumeNext,
      next: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: delivery })
        .mockImplementation(() => new Promise(() => {})),
    });
    const buffered: DeliverHookPayload[] = [];

    await runReceiver(buffered, deliveryHook);

    expect(buffered).toEqual([delivery]);
    expect(forwardTurnSteeringStep).not.toHaveBeenCalled();
  });

  it("rekeys the public delivery hook after steering is armed", async () => {
    installControlHook([
      { kind: "turn-steering-ready", steeringToken: "turn-steer" },
      { continuationToken: "http:rekeyed", kind: "turn-continuation-token" },
      parkResult(),
    ]);
    const deliveryHook = createDeliveryHook();

    await runReceiver([], deliveryHook);

    expect(deliveryHook.rekey).toHaveBeenCalledWith("http:rekeyed");
  });
});

function runReceiver(
  bufferedDeliveries: DeliverHookPayload[],
  deliveryHook = createDeliveryHook(),
): ReturnType<TurnControlReceiver["waitForAction"]> {
  const receiver = new TurnControlReceiver({
    inputQueue: createInputQueue(bufferedDeliveries, deliveryHook),
    token: "turn-control",
  });
  return receiver.waitForAction().finally(() => receiver.dispose());
}

function installControlHookFactory(
  values: Array<() => Promise<IteratorResult<TurnControlPayload>>>,
): void {
  const queue = [...values];
  createHookMock.mockReturnValue({
    token: "turn-control",
    dispose: vi.fn(),
    [Symbol.asyncIterator]() {
      return {
        next: () => queue.shift()?.() ?? Promise.resolve({ done: true, value: undefined }),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      };
    },
  });
}

function deliveryRequest(requestId: string): TurnControlPayload {
  return {
    continuationToken: "http:test",
    inboxToken: "turn-inbox",
    kind: "turn-delivery-request",
    requestId,
  };
}

function parkResult(): Extract<TurnControlPayload, { readonly kind: "turn-result" }> {
  return {
    action: { kind: "park", serializedContext: {}, sessionState: createState() },
    kind: "turn-result",
  };
}

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
  createHookMock.mockReturnValue({
    token: "turn-control",
    dispose: vi.fn(),
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const value = queue.shift();
          return value === undefined ? { done: true, value: undefined } : { done: false, value };
        },
        return: vi.fn(async () => ({ done: true, value: undefined })),
      };
    },
  });
}

function createState(): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "session",
    version: 1,
  };
}
