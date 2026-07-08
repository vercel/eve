import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

vi.mock("./forward-turn-delivery-step.js", () => ({
  forwardTurnDeliveryStep: vi.fn(),
}));

describe("TurnControlReceiver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createHookMock.mockReset();
  });

  it("forwards a buffered delivery and consumes it once the turn accepts", async () => {
    const delivery: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "hello" }] };
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
    const delivery: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "hello" }] };
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
});

function runReceiver(
  bufferedDeliveries: DeliverHookPayload[],
): ReturnType<TurnControlReceiver["waitForAction"]> {
  const receiver = new TurnControlReceiver({
    bufferedDeliveries,
    deliveryHook: createDeliveryHook(),
    token: "turn-control",
  });
  return receiver.waitForAction().finally(() => receiver.dispose());
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
