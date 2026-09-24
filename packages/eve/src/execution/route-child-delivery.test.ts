import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";

vi.mock("#execution/proxied-deliver-step.js", () => ({
  routeProxiedDeliverStep: vi.fn(),
}));

const state = (hasProxyInputRequests: boolean): DurableSessionState =>
  createTestSessionState({
    continuationToken: "parent-token",
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "" },
    hasProxyInputRequests,
    sessionId: "parent-session",
    version: 1,
  });

const delivery: DeliverHookPayload = {
  kind: "deliver",
  payloads: [{ inputResponses: [{ optionId: "approve", requestId: "request-1" }] }],
};

describe("routeDeliverToChildren", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the delivery unchanged without a step when no descendant awaits input", async () => {
    const sessionState = state(false);
    const routed = await routeDeliverToChildren({
      delivery,
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: { source: "parent" },
      sessionState,
    });

    expect(routed).toEqual({
      kind: "continue",
      remainder: delivery,
      serializedContext: { source: "parent" },
      sessionState,
    });
    expect(routeProxiedDeliverStep).not.toHaveBeenCalled();
  });

  it("routes through the proxied deliver step while a descendant awaits input", async () => {
    const routedState = state(false);
    vi.mocked(routeProxiedDeliverStep).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: { source: "routed" },
      sessionState: routedState,
    });
    const input = {
      delivery,
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: { source: "parent" },
      sessionState: state(true),
    };

    await expect(routeDeliverToChildren(input)).resolves.toEqual({
      kind: "continue",
      remainder: undefined,
      serializedContext: { source: "routed" },
      sessionState: routedState,
    });
    expect(routeProxiedDeliverStep).toHaveBeenCalledExactlyOnceWith(input);
  });
});
