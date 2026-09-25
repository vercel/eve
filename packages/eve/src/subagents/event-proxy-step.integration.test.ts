import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import type { DurableSession } from "#execution/durable-session-store.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { HookContext } from "#public/definitions/hook.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { emitProxiedSubagentEvent } from "#subagents/event-proxy-step.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";

function fixture(turnId = "parent-turn") {
  const order: string[] = [];
  const events: MessageStreamEvent[] = [];
  const typed = vi.fn(async (event: MessageStreamEvent, _ctx: HookContext) => {
    order.push(`typed:${event.type}`);
  });
  const wildcard = vi.fn((event: MessageStreamEvent, _ctx: HookContext) => {
    order.push(`wildcard:${event.type}`);
  });
  const adapter: ChannelAdapter = {
    kind: "proxy-hook-test",
    "input.requested"(data, ctx) {
      order.push("channel:input.requested");
      ctx.state.pendingRequests = data.requests;
      ctx.session.continuation?.alias("parent-thread");
    },
    "turn.completed"() {
      order.push("channel:turn.completed");
    },
    "session.waiting"() {
      order.push("channel:session.waiting");
    },
  };
  const turnAgent = { id: "parent", model: { id: "unused" }, tools: [] };
  const bundle: CompiledBundle = {
    adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    compiledArtifactsSource: {},
    graph: { root: { sandboxRegistry: { sandbox: null }, turnAgent } },
    hookRegistry: createRuntimeHookRegistry([
      {
        events: {
          "input.requested": typed,
          "turn.completed": typed,
          "session.waiting": typed,
          "*": wildcard,
        },
        logicalPath: "hooks/audit.ts",
        slug: "audit",
        sourceId: "hooks/audit.ts",
        sourceKind: "module",
      },
    ]),
    nodeId: "parent",
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    turnAgent,
  } as never;
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(SessionIdKey, "parent-session");
  const durableSession: DurableSession = {
    agent: { system: "" },
    continuationToken: "http:parent",
    history: [],
    sessionId: "parent-session",
    state: {
      "eve.harness.emission": { turnId, sequence: 1, stepIndex: 0, sessionStarted: true },
    },
  };
  const request = createSessionLimitContinuationRequest({
    sessionId: "child-session",
    violation: { kind: "input", limit: 100, usedTokens: 101 },
  });
  const hookPayload: SubagentInputRequestHookPayload = {
    kind: "subagent-input-request",
    callId: "child-call",
    childContinuationToken: "child-token",
    childSessionId: "child-session",
    subagentName: "child",
    event: { requests: [request], turnId: "child-turn", sequence: 7, stepIndex: 2 },
  };
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      const event = JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent;
      events.push(event);
      order.push(`stream:${event.type}`);
    },
  });
  return {
    ctx,
    durableSession,
    hookPayload,
    sessionWritable,
    events,
    order,
    request,
    typed,
    wildcard,
  };
}

describe("proxied stream hooks", () => {
  it.each([{ turnId: "parent-turn" }, { turnId: "" }] as const)(
    "publishes hooks in parent context (turn=$turnId)",
    async ({ turnId }) => {
      const f = fixture(turnId);
      const result = await emitProxiedSubagentEvent(f);
      const types = ["input.requested", "turn.completed", "session.waiting"];
      expect(f.events.map((event) => event.type)).toEqual(types);
      expect(f.order).toEqual(
        types.flatMap((type) => [
          `channel:${type}`,
          `stream:${type}`,
          `typed:${type}`,
          `wildcard:${type}`,
        ]),
      );
      expect(f.typed.mock.calls.map(([event]) => event)).toEqual(f.events);
      expect(f.wildcard.mock.calls.map(([event]) => event)).toEqual(f.events);
      for (const [, ctx] of [...f.typed.mock.calls, ...f.wildcard.mock.calls]) {
        expect(ctx).toMatchObject({
          session: { id: "parent-session", turn: { id: turnId || "turn_1" } },
          agent: { name: "parent", nodeId: "parent" },
          channel: { kind: "proxy-hook-test", continuationToken: "http:parent-thread" },
        });
      }
      expect(f.events[0]).toMatchObject({ data: f.hookPayload.event });
      expect(result.serializedContext[ChannelKey.name]).toMatchObject({
        state: { pendingRequests: [f.request] },
      });
      expect(result.sessionState.continuationToken).toBe("http:parent-thread");
      expect(result.sessionState.hasProxyInputRequests).toBe(true);
      const routed = routeDeliverPayload({
        payload: { inputResponses: [{ requestId: f.request.requestId, optionId: "continue" }] },
        state: result.sessionState.snapshot.session.state,
      });
      expect(routed.forSelf).toBeUndefined();
      expect(routed.forChildren).toEqual([
        {
          childContinuationToken: "child-token",
          payload: { inputResponses: [{ requestId: f.request.requestId, optionId: "continue" }] },
          retireRequestIds: [f.request.requestId],
        },
      ]);
    },
  );

  it("propagates hook failures after publication and releases the writer", async () => {
    const f = fixture();
    const error = new Error("audit unavailable");
    f.typed.mockRejectedValueOnce(error);
    await expect(emitProxiedSubagentEvent(f)).rejects.toBe(error);
    expect(f.events.map((event) => event.type)).toEqual(["input.requested"]);
    expect(f.typed).toHaveBeenCalledOnce();
    expect(f.wildcard).not.toHaveBeenCalled();
    expect(f.sessionWritable.locked).toBe(false);
  });
});
