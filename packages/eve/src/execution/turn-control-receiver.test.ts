import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { forwardTurnCancellationStep } from "#execution/forward-turn-cancellation-step.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import type { SessionCommandInbox, SessionInboxPayload } from "#execution/session-command-inbox.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

vi.mock("./forward-turn-delivery-step.js", () => ({
  forwardTurnDeliveryStep: vi.fn(),
}));

vi.mock("./forward-turn-cancellation-step.js", () => ({
  forwardTurnCancellationStep: vi.fn(),
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

  it("buffers sends and context controls that arrive during a turn", async () => {
    installControlHook([parkResult()], true);
    const bufferedDeliveries: DeliverHookPayload[] = [];
    const bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset"> = [];

    const action = await runReceiver(bufferedDeliveries, {
      bufferedSessionControls,
      commandInbox: createCommandInbox([
        { kind: "send", payload: { message: "follow up" } },
        { kind: "clear" },
        { kind: "compact" },
        { kind: "session-timeout" },
      ]),
    });

    expect(action.kind).toBe("park");
    expect(bufferedDeliveries).toEqual([
      {
        auth: undefined,
        caller: undefined,
        kind: "deliver",
        payloads: [{ message: "follow up" }],
        requestId: undefined,
      },
    ]);
    expect(bufferedSessionControls).toEqual(["clear", "compact", "expired"]);
  });

  it("forwards cancel and reset through the active turn's private hook", async () => {
    installControlHook([parkResult()], true);
    const bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset"> = [];

    const action = await runReceiver([], {
      bufferedSessionControls,
      commandInbox: createCommandInbox([
        { kind: "cancel", turnId: "turn_3" },
        { kind: "reset", reason: "Start over" },
      ]),
    });

    expect(action.kind).toBe("park");
    expect(forwardTurnCancellationStep).toHaveBeenNthCalledWith(1, {
      payload: { turnId: "turn_3" },
      token: "turn-control:cancel",
    });
    expect(forwardTurnCancellationStep).toHaveBeenNthCalledWith(2, {
      payload: {},
      token: "turn-control:cancel",
    });
    expect(bufferedSessionControls).toEqual(["reset"]);
  });
});

function runReceiver(
  bufferedDeliveries: DeliverHookPayload[],
  options: {
    readonly bufferedSessionControls?: Array<"clear" | "compact" | "expired" | "reset">;
    readonly commandInbox?: SessionCommandInbox;
  } = {},
): ReturnType<TurnControlReceiver["waitForAction"]> {
  const receiver = new TurnControlReceiver({
    bufferedDeliveries,
    bufferedSessionControls: options.bufferedSessionControls ?? [],
    commandInbox: options.commandInbox ?? createCommandInbox(),
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

function createCommandInbox(
  values: readonly SessionInboxPayload[] = [],
  overrides: Partial<SessionCommandInbox> = {},
): SessionCommandInbox {
  const queue = [...values];
  return {
    claimStable: vi.fn(),
    consumeNext: vi.fn(),
    next: vi.fn(() => {
      const value = queue.shift();
      return value === undefined
        ? new Promise<IteratorResult<SessionInboxPayload>>(() => {})
        : Promise.resolve({ done: false, value });
    }),
    rekeyContinuation: vi.fn(),
    ...overrides,
  };
}

function installControlHook(values: readonly TurnControlPayload[], delayed = false): void {
  const queue = [...values];
  createHookMock.mockReturnValue({
    token: "turn-control",
    dispose: vi.fn(),
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (delayed) await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
