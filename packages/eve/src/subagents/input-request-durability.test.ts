import { beforeEach, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { findRunningAgentHandle } from "#subagents/handles/query.js";

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));
vi.mock("#subagents/handles/query.js", () => ({ findRunningAgentHandle: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

it.each(["subagent", "workflow"] as const)(
  "keeps %s response routes when a published event's hook fails",
  async (origin) => {
    for (const failedType of ["input.requested", "turn.completed", "session.waiting"] as const) {
      const error = new Error(`failed ${failedType} hook`);
      const events: MessageStreamEvent[] = [];
      const routesAtPublication: boolean[] = [];
      const request = createSessionLimitContinuationRequest({
        sessionId: "child-session",
        violation: { kind: "input", limit: 100, usedTokens: 101 },
      });
      const adapter: ChannelAdapter = {
        kind: "durability-test",
        "input.requested"() {
          routesAtPublication.push(cursor.sessionState.hasProxyInputRequests);
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
              "*": (event) => {
                if (event.type === failedType) throw error;
              },
            },
            logicalPath: "hooks/audit.ts",
            slug: "audit",
            sourceId: "hooks/audit.ts",
            sourceKind: "module",
          },
        ]),
        resolvedAgent: { config: {} },
        subagentRegistry: {},
        turnAgent,
      } as never;
      vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
      vi.mocked(findRunningAgentHandle).mockReturnValue({
        identity: { name: "child" },
        address: { sessionId: "child-session" },
      } as never);
      const ctx = new ContextContainer();
      ctx.set(AuthKey, null);
      ctx.set(BundleKey, bundle);
      ctx.set(ChannelKey, adapter);
      ctx.set(ContinuationTokenKey, "http:parent");
      ctx.set(ModeKey, "conversation");
      ctx.set(SessionIdKey, "parent-session");
      const sessionWritable = new WritableStream<Uint8Array>({
        write(chunk) {
          events.push(JSON.parse(new TextDecoder().decode(chunk)));
        },
      });
      const cursor = new SessionStateCursor({
        inbox: { claimSessionHooks: vi.fn() },
        sessionWritable,
        serializedContext: serializeContext(ctx),
        sessionState: createTestSessionState({
          sessionId: "parent-session",
          continuationToken: "http:parent",
        }),
      });
      const publish =
        origin === "subagent"
          ? admitSessionInboxPayload(
              {
                kind: "subagent-input-request",
                callId: "child-call",
                childSessionId: "child-session",
                childContinuationToken: "child-token",
                subagentName: "child",
                event: { requests: [request], sequence: 0, stepIndex: 0, turnId: "child-turn" },
              },
              { cursor, queue: new SessionInputQueue() },
            )
          : handleWorkflowToolRunMessage({
              callbackMetadataUrl: "https://parent.example",
              cursor,
              message: {
                kind: "request",
                replyTo: "child-token",
                from: {
                  callId: "child-call",
                  execution: "blocking",
                  input: {},
                  runId: "child-session",
                  sequence: 0,
                  stepIndex: 0,
                  toolName: "child",
                  turnId: "child-turn",
                },
                request: { kind: "input-batch", requests: [request] },
              },
            });
      await expect(publish).rejects.toBe(error);
      expect(routesAtPublication).toEqual([true]);
      expect(events[0]).toMatchObject({ type: "input.requested", data: { requests: [request] } });
      expect(events.at(-1)?.type).toBe(failedType);
      expect(sessionWritable.locked).toBe(false);
      expect(cursor.sessionState.hasProxyInputRequests).toBe(true);
      const routed = routeDeliverPayload({
        payload: { inputResponses: [{ requestId: request.requestId, optionId: "continue" }] },
        state: cursor.sessionState.snapshot.session.state,
      });
      expect(routed.forSelf).toBeUndefined();
      expect(routed.forChildren).toEqual([
        {
          answerHook: origin === "workflow" ? { runId: "child-session" } : undefined,
          childContinuationToken: "child-token",
          payload: { inputResponses: [{ requestId: request.requestId, optionId: "continue" }] },
          retireRequestIds: [request.requestId],
        },
      ]);
    }
  },
);
