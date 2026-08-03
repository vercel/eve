import { describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import { filterAwaitedTaskWakePayloadsStep } from "#execution/tasks/wake-suppression-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";

vi.mock("./tasks/wake-suppression-step.js", () => ({
  filterAwaitedTaskWakePayloadsStep: vi.fn(),
}));

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

describe("nextTurnDelivery task wake suppression", () => {
  it("routes only unsuppressed payloads and carries the updated session state", async () => {
    const taskWake = {
      kind: "deliver",
      payloads: [
        {
          message: "task done",
          taskNotification: { status: "completed", taskId: "task_1" },
        },
        { message: "ordinary delivery" },
      ],
    } satisfies DeliverHookPayload;
    const initialState = {
      continuationToken: "token",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn" },
      hasProxyInputRequests: false,
      sessionId: "session",
      version: 1,
    } as const;
    const filteredState = { ...initialState, continuationToken: "next-token" };
    vi.mocked(filterAwaitedTaskWakePayloadsStep).mockResolvedValue({
      payloads: [{ message: "ordinary delivery" }],
      sessionState: filteredState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "continue",
      remainder: { message: "ordinary delivery" },
    });
    const hook: SessionDeliveryHook = {
      consumeNext: vi.fn(),
      consumeSessionTimeout: () => false,
      next: vi.fn(),
      rekey: vi.fn(),
    };

    const result = await nextTurnDelivery({
      bufferedDeliveries: [taskWake],
      deliveryHook: hook,
      driverWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: initialState,
    });

    expect(result).toMatchObject({
      kind: "turn",
      remainder: { message: "ordinary delivery" },
      sessionState: filteredState,
    });
    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ message: "ordinary delivery" }],
        sessionState: filteredState,
      }),
    );
  });
});
