import { describe, expect, it } from "vitest";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { DeliverPayload, SubagentInputRequestHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { serializeContext } from "#context/serialize.js";
import { hasProxyInputRequests, upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessEmitFn, HarnessSession } from "#harness/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#runtime/input/types.js";
import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { emitProxiedInputRequest, routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";

/**
 * Integration coverage for subagent HITL proxy emission and routing.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Minimal synthetic bundle satisfying the runtime's `ChannelKey` codec:
 * the codec pulls `adapterRegistry` off the bundle in context and
 * rehydrates the adapter by `kind`. Every other bundle field is
 * unused by the proxy path under test.
 */
function buildMockBundle(adapters: readonly ChannelAdapter[]): CompiledBundle {
  const channels: readonly ResolvedChannelDefinition[] = adapters.map((adapter, index) => ({
    adapter,
    fetch: async () => new Response(null),
    logicalPath: `channels/mock-${index}.ts`,
    method: "POST",
    name: `mock-${index}`,
    sourceId: `channels/mock-${index}`,
    sourceKind: "module",
    urlPath: `/eve/mock-${index}`,
  }));

  // Only `adapterRegistry` and `hookRegistry` are exercised by the
  // proxy path. The other fields are stubbed with empty objects via
  // single `as T` casts so the bundle satisfies `CompiledBundle`
  // without a cast through `unknown`.
  return {
    adapterRegistry: createRuntimeAdapterRegistry({ channels }),
    compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
    graph: {} as CompiledBundle["graph"],
    hookRegistry: createEmptyHookRegistry(),
    moduleMap: {} as CompiledBundle["moduleMap"],
    resolvedAgent: {} as CompiledBundle["resolvedAgent"],
    subagentRegistry: {} as CompiledBundle["subagentRegistry"],
    toolRegistry: {} as CompiledBundle["toolRegistry"],
    turnAgent: {} as CompiledBundle["turnAgent"],
  };
}

/**
 * Builds the Slack-style mock adapter used by the Finding #1
 * regression test. The handler shapes mirror the real
 * `packages/eve/src/channel/slack-adapter.ts` contract:
 *  - `input.requested` caches `pendingRequests` on `ctx.state` so a
 *    later free-form text reply can resolve against the batch.
 *  - `deliver` resolves a text `message` into `inputResponses` via the
 *    shared {@link resolveTextToResponses} helper when pending
 *    requests are cached; otherwise it passes through.
 */
interface SlackishState extends Record<string, unknown> {
  pendingRequests?: readonly InputRequest[];
}

type SlackishCtx = ChannelAdapterContext<SlackishState>;

const SLACKISH_ADAPTER_KIND = "slackish-mock";

function buildSlackishAdapter(): ChannelAdapter<SlackishCtx> {
  return {
    kind: SLACKISH_ADAPTER_KIND,
    // No initial state: after rehydration, buildAdapterContext creates a
    // fresh state object. This verifies handler mutations are persisted
    // back onto ChannelKey before serialization.
    "input.requested"(data, ctx) {
      // Cache the batch on adapter state so the workflow boundary can
      // serialize it after the handler runs.
      ctx.state.pendingRequests = data.requests;
    },
    deliver(payload, ctx) {
      const message = typeof payload.message === "string" ? payload.message : undefined;
      const pending = ctx.state.pendingRequests ?? [];

      if (message !== undefined && pending.length > 0) {
        const responses = resolveTextToResponses(message, pending);

        if (responses.length > 0) {
          ctx.state.pendingRequests = [];
          return { inputResponses: responses };
        }
      }

      return payload;
    },
  };
}

function buildHitlPayload(input: {
  readonly callId: string;
  readonly childContinuationToken: string;
  readonly childSessionId: string;
  readonly request: InputRequest;
  readonly subagentName: string;
}): SubagentInputRequestHookPayload {
  return {
    callId: input.callId,
    childContinuationToken: input.childContinuationToken,
    childSessionId: input.childSessionId,
    event: {
      requests: [input.request],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    kind: "subagent-input-request",
    subagentName: input.subagentName,
  };
}

function buildApprovalRequest(requestId: string): InputRequest {
  return {
    action: {
      callId: requestId,
      input: {},
      kind: "tool-call",
      toolName: "create_issue",
    },
    display: "confirmation",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    prompt: "Approve?",
    requestId,
  };
}

function buildEmptySession(continuationToken: string, sessionId: string): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "test",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken,
    history: [],
    sessionId,
  };
}

/**
 * Builds an adapter-aware emit helper and a captured-events sink
 * paired to one parent context. The returned `emit` mirrors the
 * adapter wiring the real runtimes build per-step, so tests exercise
 * the same handler path production does. `persistAdapterState` mirrors
 * the workflow caller's post-step `ctx.set(ChannelKey, …)` — pin
 * whatever mutations the adapter's event handlers recorded on
 * `adapterCtx.state` back onto the ctx so a later serialize/deserialize
 * round-trip sees them.
 */
function buildCapturingEmit(ctx: ContextContainer): {
  readonly emit: HarnessEmitFn;
  readonly events: HandleMessageStreamEvent[];
  readonly persistAdapterState: () => void;
} {
  const events: HandleMessageStreamEvent[] = [];
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const emit: HarnessEmitFn = async (event) => {
    const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
    events.push(transformed);
  };
  const persistAdapterState = () => {
    ctx.set(ChannelKey, { ...adapter, state: { ...adapterCtx.state } });
  };
  return { emit, events, persistAdapterState };
}

// ---------------------------------------------------------------------------
// Test 1 — Slack-style text-approve regression for Finding #1
// ---------------------------------------------------------------------------

describe("subagent HITL proxy → Slack-style text-approve regression (Finding #1)", () => {
  it("persists adapter-state mutations across a serialize/deserialize boundary so text replies resolve against the cached batch", async () => {
    // Build the parent-side adapter registry + bundle so the
    // ChannelKey codec can round-trip our Slack-like adapter.
    const slackishAdapter = buildSlackishAdapter();
    const bundle = buildMockBundle([slackishAdapter]);

    const ctx = new ContextContainer();
    ctx.set(BundleKey, bundle);
    ctx.set(ChannelKey, slackishAdapter);

    // Drive a child HITL batch up through the parent's adapter. This
    // is the exact call shape used by `runProxyInputRequestStep` on
    // the workflow runtime.
    const approvalRequest = buildApprovalRequest("req-approve-1");
    const hookPayload = buildHitlPayload({
      callId: "call-1",
      childContinuationToken: "subagent:parent:call-1",
      childSessionId: "sess-child",
      request: approvalRequest,
      subagentName: "linear",
    });

    const { emit, events, persistAdapterState } = buildCapturingEmit(ctx);
    const { entries, session: sessionAfterEmit } = await emitProxiedInputRequest({
      emit,
      hookPayload,
      mode: "conversation",
      session: buildEmptySession("parent-token", "sess-parent"),
    });
    // Simulate the workflow step's post-step
    // `ctx.set(ChannelKey, { …adapter, state })` — the mutation the
    // slackish adapter recorded on `adapterCtx.state.pendingRequests`
    // must land on `ctx` so the serialize boundary below captures it.
    persistAdapterState();

    // The caller-owned ChannelKey update pins the handler's state
    // mutation onto the serialized context.
    const afterEmitAdapter = ctx.require(ChannelKey);
    expect((afterEmitAdapter.state as SlackishState | undefined)?.pendingRequests).toEqual([
      approvalRequest,
    ]);
    expect(entries).toEqual([["req-approve-1", "subagent:parent:call-1"]]);

    // The parent is in conversation mode, so the helper follows the
    // proxied `input.requested` with a `turn.completed` +
    // `session.waiting` pair so client event-stream readers stop
    // draining and prompt for the HITL response.
    const emittedTypes = events.map((event) => event.type);
    expect(emittedTypes).toEqual(["input.requested", "turn.completed", "session.waiting"]);

    // The returned session carries the advanced emission state so
    // the next harness step starts a fresh logical turn.
    expect(sessionAfterEmit.state?.["eve.harness.emission"]).toBeDefined();

    // The serialized adapter state must include mutations made while
    // rendering the proxied input request.
    const serialized = serializeContext(ctx);
    const serializedChannel = serialized[ChannelKey.name] as {
      readonly kind: string;
      readonly state: SlackishState;
    };
    expect(serializedChannel.state.pendingRequests).toEqual([approvalRequest]);

    // Drive a free-form text reply through a freshly-constructed
    // adapter rehydrated from the serialized context — the Slack
    // channel's real behaviour when a user types "approve" in the
    // thread after clicking past the Block Kit buttons. The adapter
    // resolves the text against its cached batch and returns
    // structured `inputResponses`.
    const rehydratedAdapter: ChannelAdapter<SlackishCtx> = {
      ...slackishAdapter,
      state: serializedChannel.state,
    };
    const rehydratedCtx = new ContextContainer();
    rehydratedCtx.set(BundleKey, bundle);
    rehydratedCtx.set(ChannelKey, rehydratedAdapter as ChannelAdapter);

    const adapterCtx = buildAdapterContext<SlackishCtx>(rehydratedAdapter, rehydratedCtx);
    const deliverResult = await rehydratedAdapter.deliver?.({ message: "approve" }, adapterCtx);

    expect(deliverResult).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "req-approve-1" }],
    });

    // The resolved responses now flow through the proxy router. With
    // the child's proxy entry recorded on the parent session, the
    // response routes back down to the right descendant.
    const parkedSession = upsertProxyInputRequests({
      entries,
      forChildContinuationToken: hookPayload.childContinuationToken,
      session: buildEmptySession("parent-token", "sess-parent"),
    });

    const routed = routeDeliverPayload({
      payload: deliverResult as DeliverPayload,
      state: parkedSession.state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren).toEqual([
      {
        childContinuationToken: "subagent:parent:call-1",
        payload: {
          inputResponses: [{ optionId: "approve", requestId: "req-approve-1" }],
        },
      },
    ]);
  });

  it("in task mode, skips the `turn.completed` + `session.waiting` boundary so scheduled chains do not fake a wait", async () => {
    // Scheduled-task roots must not emit `session.waiting` — a proxied
    // HITL there signals an impending `SUBAGENT_EXECUTION_FAILED`, not
    // a client-facing park. This test pins the mode-gating in place
    // so a refactor cannot re-introduce the boundary pair for task
    // mode.
    const slackishAdapter = buildSlackishAdapter();
    const bundle = buildMockBundle([slackishAdapter]);

    const ctx = new ContextContainer();
    ctx.set(BundleKey, bundle);
    ctx.set(ChannelKey, slackishAdapter);

    const { emit, events } = buildCapturingEmit(ctx);
    await emitProxiedInputRequest({
      emit,
      hookPayload: buildHitlPayload({
        callId: "call-task-1",
        childContinuationToken: "subagent:task-parent:call-task-1",
        childSessionId: "sess-task-child",
        request: buildApprovalRequest("req-task-1"),
        subagentName: "linear",
      }),
      mode: "task",
      session: buildEmptySession("task-parent-token", "sess-task-parent"),
    });

    expect(events.map((event) => event.type)).toEqual(["input.requested"]);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Nested subagent HITL proxying across multiple descendants
// ---------------------------------------------------------------------------

describe("subagent HITL proxy → concurrent-descendant routing", () => {
  it("proxies two descendants' HITL batches through the parent and routes each response back to the matching child", async () => {
    // Simulates the "HTTP conversation → two-level nested subagent"
    // scenario at the routing seam: two concurrent descendants
    // produce proxy entries on the parent session; a single
    // inbound deliver carries responses for both; the routing helper
    // splits them by `requestId` → child continuation token without
    // mixing the payloads.
    const slackishAdapter = buildSlackishAdapter();
    const bundle = buildMockBundle([slackishAdapter]);

    const ctx = new ContextContainer();
    ctx.set(BundleKey, bundle);
    ctx.set(ChannelKey, slackishAdapter);

    const { emit, persistAdapterState } = buildCapturingEmit(ctx);

    // Emit HITL from descendant A.
    const requestA = buildApprovalRequest("req-a");
    const payloadA = buildHitlPayload({
      callId: "call-a",
      childContinuationToken: "subagent:parent:call-a",
      childSessionId: "sess-a",
      request: requestA,
      subagentName: "descendantA",
    });
    const { entries: entriesA } = await emitProxiedInputRequest({
      emit,
      hookPayload: payloadA,
      mode: "conversation",
      session: buildEmptySession("parent-token", "sess-parent"),
    });

    // Emit HITL from descendant B.
    const requestB = buildApprovalRequest("req-b");
    const payloadB = buildHitlPayload({
      callId: "call-b",
      childContinuationToken: "subagent:parent:call-b",
      childSessionId: "sess-b",
      request: requestB,
      subagentName: "descendantB",
    });
    const { entries: entriesB } = await emitProxiedInputRequest({
      emit,
      hookPayload: payloadB,
      mode: "conversation",
      session: buildEmptySession("parent-token", "sess-parent"),
    });
    persistAdapterState();

    // Both batches' `pendingRequests` are cached on the same parent
    // adapter — the later write does not evict the earlier one from
    // the proxy map, because the map is keyed by
    // `childContinuationToken` and each child owns its own entries.
    const adapterState = (ctx.require(ChannelKey).state as SlackishState | undefined) ?? {};
    expect(adapterState.pendingRequests).toEqual([requestB]);

    // Build the parent session carrying both children's proxy
    // entries (what the parent runtime would accumulate across the
    // two proxy steps).
    let parkedSession = buildEmptySession("parent-token", "sess-parent");
    parkedSession = upsertProxyInputRequests({
      entries: entriesA,
      forChildContinuationToken: payloadA.childContinuationToken,
      session: parkedSession,
    });
    parkedSession = upsertProxyInputRequests({
      entries: entriesB,
      forChildContinuationToken: payloadB.childContinuationToken,
      session: parkedSession,
    });

    expect(hasProxyInputRequests(parkedSession.state)).toBe(true);

    // One inbound deliver carrying responses for both descendants.
    // Simulates a UI that lets the user answer both prompts before
    // hitting send — the routing layer must not mix them up.
    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [
          { optionId: "approve", requestId: "req-a" },
          { optionId: "deny", requestId: "req-b" },
        ],
      },
      state: parkedSession.state,
    });

    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren).toHaveLength(2);

    // Each descendant receives only its own response — no cross
    // contamination.
    const byChild = new Map(
      routed.forChildren.map((entry) => [entry.childContinuationToken, entry.payload]),
    );

    expect(byChild.get("subagent:parent:call-a")).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "req-a" }],
    });
    expect(byChild.get("subagent:parent:call-b")).toEqual({
      inputResponses: [{ optionId: "deny", requestId: "req-b" }],
    });

    // A response whose requestId does not match any proxy entry
    // falls through to the parent so the parent's own harness can
    // process it (unroutable response recovery). The routing layer
    // never silently drops unrecognized requestIds.
    const unrouted = routeDeliverPayload({
      payload: { inputResponses: [{ requestId: "req-unknown", text: "stray" }] },
      state: parkedSession.state,
    });

    expect(unrouted.forChildren).toEqual([]);
    expect(unrouted.forSelf).toEqual({
      inputResponses: [{ requestId: "req-unknown", text: "stray" }],
    });
  });
});
